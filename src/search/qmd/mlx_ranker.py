"""Optional Apple GPU execution of the installed GGUF, using MLX-LM's Qwen3.

Input tokens come from the existing ranking template/tokenizer. No model fetch,
new quantization, candidate pruning or document truncation happens here.
"""
import json
import hashlib
import os
from pathlib import Path
import re
import sys
import tempfile


def batches(rows, maximum=4, padding_budget=512):
    """Bound memory and avoid padding every document to the longest document."""
    order = sorted(range(len(rows)), key=lambda i: len(rows[i]))
    start = 0
    while start < len(order):
        ids = [order[start]]
        while len(ids) < maximum and start + len(ids) < len(order):
            proposed = ids + [order[start + len(ids)]]
            lengths = [len(rows[i]) for i in proposed]
            if max(lengths) * len(proposed) - sum(lengths) > padding_budget:
                break
            ids = proposed
        yield ids
        start += len(ids)


def read_gguf(model_path):
    import gguf
    import numpy as np
    import mlx.core as mx
    # MLX's built-in GGUF loader uses a writable mapping, changing ctime even
    # when bytes are unchanged. llama.cpp's reader supports a true read-only map.
    reader = gguf.GGUFReader(model_path, mode='r')
    metadata = {name: field.contents() for name, field in reader.fields.items()
                if name.startswith(('general.', 'qwen3.'))}
    weights = {}
    for tensor in reader.tensors:
        if tensor.tensor_type not in (gguf.GGMLQuantizationType.F32, gguf.GGMLQuantizationType.F16, gguf.GGMLQuantizationType.Q8_0):
            raise ValueError('MLX acceleration supports F32, F16 and Q8_0 tensors')
        data = gguf.dequantize(tensor.data, tensor.tensor_type)
        if tensor.tensor_type == gguf.GGMLQuantizationType.Q8_0:
            data = data.astype(np.float16)
        weights[tensor.name] = mx.array(data)
    return weights, metadata


def cached_gguf(model_path, cache_directory=None):
    if cache_directory is None:
        return read_gguf(model_path)
    import mlx.core as mx
    source = Path(model_path)
    stat = source.stat()
    # Version the conversion format. The model's weights and read-only file
    # identity determine reuse, independently of search results or source data.
    identity = [1, str(source.resolve()), stat.st_dev, stat.st_ino,
                stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]
    key = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
    directory = Path(cache_directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / (key + '.safetensors')
    if path.exists():
        try:
            weights, metadata = mx.load(str(path), return_metadata=True)
            return weights, json.loads(metadata['gguf'])
        except (OSError, ValueError, RuntimeError, KeyError):
            pass
    weights, metadata = read_gguf(model_path)
    temporary = tempfile.NamedTemporaryFile(dir=directory, suffix='.safetensors', delete=False)
    temporary.close()
    try:
        mx.save_safetensors(temporary.name, weights, metadata={'gguf': json.dumps(metadata)})
        os.replace(temporary.name, path)
    finally:
        Path(temporary.name).unlink(missing_ok=True)
    return weights, metadata


def load_model(model_path, cache_directory=None):
    import mlx.core as mx
    import mlx.nn as nn
    from mlx.utils import tree_flatten, tree_unflatten
    from mlx_lm.models.qwen3 import ModelArgs, Qwen3Model

    weights, meta = cached_gguf(model_path, cache_directory)
    if (meta.get('general.architecture') != 'qwen3'
            or meta.get('qwen3.classifier.output_labels') != ['yes', 'no']
            or int(meta.get('general.file_type', -1)) not in (0, 1, 7)):
        raise ValueError('MLX requires a Qwen3 yes/no ranking GGUF in F32, F16 or Q8_0 format')
    if any(key.startswith('qwen3.rope.scaling.') for key in meta):
        raise ValueError('This GGUF uses rotary scaling; use the portable engine for this model')

    def integer(key):
        return int(meta['qwen3.' + key])

    args = ModelArgs(
        model_type='qwen3', hidden_size=integer('embedding_length'),
        num_hidden_layers=integer('block_count'), intermediate_size=integer('feed_forward_length'),
        num_attention_heads=integer('attention.head_count'),
        num_key_value_heads=integer('attention.head_count_kv'),
        head_dim=integer('attention.key_length'),
        rms_norm_eps=float(meta['qwen3.attention.layer_norm_rms_epsilon']),
        vocab_size=weights['token_embd.weight'].shape[0],
        max_position_embeddings=integer('context_length'),
        rope_theta=float(meta['qwen3.rope.freq_base']), tie_word_embeddings=True)
    model = Qwen3Model(args)

    class Norm(nn.RMSNorm):
        def __call__(self, x):
            # Retain the original F32 normalization weights, then restore the
            # activation dtype instead of promoting every subsequent matrix.
            return super().__call__(x).astype(x.dtype)

    model.update_modules(tree_unflatten([(path, Norm(module.weight.shape[0], args.rms_norm_eps))
                          for path, module in tree_flatten(model.leaf_modules(), is_leaf=lambda m: isinstance(m, nn.Module))
                          if isinstance(module, nn.RMSNorm)]))
    names = {
        'attn_q': 'self_attn.q_proj', 'attn_k': 'self_attn.k_proj',
        'attn_v': 'self_attn.v_proj', 'attn_output': 'self_attn.o_proj',
        'attn_q_norm': 'self_attn.q_norm', 'attn_k_norm': 'self_attn.k_norm',
        'attn_norm': 'input_layernorm', 'ffn_norm': 'post_attention_layernorm',
        'ffn_gate': 'mlp.gate_proj', 'ffn_up': 'mlp.up_proj', 'ffn_down': 'mlp.down_proj',
    }
    mapped = []
    for key, value in weights.items():
        if key.startswith('cls.'):
            continue
        match = re.fullmatch(r'blk\.(\d+)\.([^.]+)\.(.+)', key)
        if match:
            target = f'layers.{match[1]}.{names[match[2]]}.{match[3]}'
        else:
            target = key.replace('token_embd', 'embed_tokens').replace('output_norm', 'norm')
        mapped.append((target, value))
    model.load_weights(mapped, strict=True)
    head = weights['cls.output.weight']
    if head.shape != (2, args.hidden_size):
        raise ValueError('Unexpected ranking classifier shape')
    mx.eval(model.parameters(), head)
    return model, head


def rank(model_path, rows):
    model, head = load_model(model_path)
    return rank_loaded(model, head, rows)


def rank_loaded(model, head, rows):
    import mlx.core as mx
    if any(max(row) >= model.args.vocab_size for row in rows):
        raise ValueError('Ranking input exceeds the model vocabulary')
    if any(len(row) > model.args.max_position_embeddings for row in rows):
        raise ValueError('Ranking input exceeds the model context')
    scores = [None] * len(rows)
    for ids in batches(rows):
        width = max(len(rows[i]) for i in ids)
        tokens = mx.array([rows[i] + [0] * (width - len(rows[i])) for i in ids])
        hidden = model(tokens)
        # Causal attention makes right padding invisible to each last real token.
        last = hidden[mx.arange(len(ids)), mx.array([len(rows[i]) - 1 for i in ids])]
        probabilities = mx.softmax((last @ head.T).astype(mx.float32), axis=-1)[:, 0]
        mx.eval(probabilities)
        for i, score in zip(ids, probabilities.tolist()):
            scores[i] = score
    return scores


def main():
    model, head = load_model(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    while line := sys.stdin.buffer.readline(5 * 1024 * 1024 + 1):
        if len(line) > 5 * 1024 * 1024:
            raise ValueError('Ranking request exceeds budget')
        request = json.loads(line)
        try:
            rows = request['input']['rows']
            if (not isinstance(rows, list) or not 1 <= len(rows) <= 100
                    or any(not isinstance(row, list) or not 1 <= len(row) <= 4096
                           or any(type(token) is not int or token < 0 for token in row) for row in rows)):
                raise ValueError('Invalid ranking token batch')
            reply = {'id': request['id'], 'result': rank_loaded(model, head, rows)}
        except Exception as error:
            reply = {'id': request['id'], 'error': str(error)}
        print('SOURCE_SEARCH_REPLY ' + json.dumps(reply, allow_nan=False), flush=True)


if __name__ == '__main__':
    main()
