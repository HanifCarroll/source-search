"""Local cross-encoder inference using ONNX Runtime and Hugging Face Tokenizers."""
import json
import math
from pathlib import Path
import sys


def encode_windows(tokenizer, query, documents, max_tokens):
    """Cover every document token with overlapping windows; never truncate prose."""
    windows = []
    tokenizer.no_padding()
    tokenizer.no_truncation()
    query_length = len(tokenizer.encode(query, add_special_tokens=False).ids)
    capacity = max_tokens - query_length - tokenizer.num_special_tokens_to_add(True)
    if capacity < 16:
        raise ValueError('Query is too long for this ranker; shorten it or use deep search')
    for index, document in enumerate(documents):
        tokenizer.no_truncation()
        full = tokenizer.encode(query, document)
        expected = {offset for offset, sequence in zip(full.offsets, full.sequence_ids)
                    if sequence == 1 and offset[1] > offset[0]}
        tokenizer.enable_truncation(max_length=max_tokens, stride=min(64, capacity // 4), strategy='only_second')
        first = tokenizer.encode(query, document)
        parts = [first, *first.overflowing]
        actual = {offset for part in parts for offset, sequence in zip(part.offsets, part.sequence_ids)
                  if sequence == 1 and offset[1] > offset[0]}
        if actual != expected:
            raise ValueError('Tokenizer omitted candidate text')
        windows.extend((index, part) for part in parts)
    return sorted(windows, key=lambda entry: len(entry[1].ids))


class Ranker:
    def __init__(self, settings):
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.np = np
        directory = Path(settings['directory']).resolve()
        filename = Path(settings['file'])
        if filename.is_absolute() or '..' in filename.parts:
            raise ValueError('Use a model-relative ONNX filename')
        # Hugging Face snapshots link their files to a shared immutable blob
        # cache. Keep those supported links; validate the requested path itself.
        model = directory / filename
        config = json.loads((directory / 'config.json').read_text())
        self.pad_id = config['pad_token_id']
        self.max_tokens = settings['maxTokens']
        self.batch_size = settings['batchSize']
        self.tokenizer = Tokenizer.from_file(str(directory / 'tokenizer.json'))
        options = ort.SessionOptions()
        options.intra_op_num_threads = settings['threads']
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
        self.inputs = {value.name for value in self.session.get_inputs()}
        if not self.inputs <= {'input_ids', 'attention_mask', 'token_type_ids'}:
            raise ValueError('Unsupported cross-encoder model inputs')

    def rank(self, query, documents):
        if not isinstance(query, str) or not query.strip() or len(query) > 1000:
            raise ValueError('Invalid ranking query')
        if not isinstance(documents, list) or not 1 <= len(documents) <= 80:
            raise ValueError('Ranking requires 1–80 passages')
        if any(not isinstance(text, str) or not text or len(text) > 40000 for text in documents):
            raise ValueError('Invalid ranking passage')
        windows = encode_windows(self.tokenizer, query, documents, self.max_tokens)
        scores = [-math.inf] * len(documents)
        for offset in range(0, len(windows), self.batch_size):
            batch = windows[offset:offset + self.batch_size]
            width = max(len(part.ids) for _, part in batch)
            def padded(field, padding):
                return self.np.array([getattr(part, field) + [padding] * (width - len(part.ids))
                                     for _, part in batch], dtype=self.np.int64)
            arrays = {'input_ids': padded('ids', self.pad_id), 'attention_mask': padded('attention_mask', 0),
                      'token_type_ids': padded('type_ids', 0)}
            logits = self.session.run(None, {name: arrays[name] for name in self.inputs})[0]
            if logits.size != len(batch):
                raise ValueError('Ranker must return one logit per passage')
            for (index, _), logit in zip(batch, logits.reshape(-1)):
                value = float(logit)
                if not math.isfinite(value):
                    raise ValueError('Ranker returned a nonfinite score')
                scores[index] = max(scores[index], value)
        if any(not math.isfinite(score) for score in scores):
            raise ValueError('Ranker omitted candidate text')
        return [1 / (1 + math.exp(-max(-80, min(80, score)))) for score in scores]


def main():
    ranker = Ranker(json.loads(sys.argv[1]))
    while line := sys.stdin.buffer.readline(4 * 1024 * 1024 + 1):
        if len(line) > 4 * 1024 * 1024:
            raise ValueError('Ranking request exceeds budget')
        request = json.loads(line)
        try:
            data = request['input']
            reply = {'id': request['id'], 'result': ranker.rank(data['query'], data['documents'])}
        except Exception as error:
            reply = {'id': request['id'], 'error': str(error)}
        print('SOURCE_SEARCH_REPLY ' + json.dumps(reply, allow_nan=False), flush=True)


if __name__ == '__main__':
    main()
