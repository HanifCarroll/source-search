import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('onnx_ranker', Path(__file__).parents[1] / 'src/search/qmd/onnx_ranker.py')
ranker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ranker)


@unittest.skipUnless(importlib.util.find_spec('tokenizers') and importlib.util.find_spec('numpy'),
                     'optional ranking environment not installed')
class PortableRankingTest(unittest.TestCase):
    def fixture(self):
        import numpy as np
        from tokenizers import Tokenizer, models, pre_tokenizers, processors
        tokenizer = Tokenizer(models.WordLevel({'[UNK]': 0, '[PAD]': 1, '[CLS]': 2,
                                               '[SEP]': 3, 'cobalt': 4, 'amber': 5, 'target': 6}, unk_token='[UNK]'))
        tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
        tokenizer.post_processor = processors.TemplateProcessing(
            single='[CLS] $A [SEP]', pair='[CLS] $A [SEP] $B:1 [SEP]:1',
            special_tokens=[('[CLS]', 2), ('[SEP]', 3)])

        class Session:
            def run(self, _outputs, arrays):
                # The padding mask must cover actual tokens, including pad ID != 0.
                self_test.assertTrue(np.array_equal(arrays['attention_mask'], (arrays['input_ids'] != 1).astype(np.int64)))
                return [np.any(arrays['input_ids'] == 6, axis=1).astype(np.float32).reshape(-1, 1) * 8 - 4]
        self_test = self
        model = ranker.Ranker.__new__(ranker.Ranker)
        model.np, model.tokenizer, model.pad_id = np, tokenizer, 1
        model.max_tokens, model.batch_size = 32, 3
        model.inputs = {'input_ids', 'attention_mask', 'token_type_ids'}
        model.session = Session()
        return model

    def test_windows_keep_late_evidence_and_restore_document_order(self):
        model = self.fixture()
        documents = ['amber ' * 80 + 'target', 'cobalt amber', 'target', 'amber ' * 90]
        together = model.rank('cobalt', documents)
        separate = [model.rank('cobalt', [document])[0] for document in documents]
        self.assertEqual(together, separate)
        self.assertGreater(together[0], .98)
        self.assertLess(together[1], .02)
        self.assertGreater(together[2], .98)
        self.assertLess(together[3], .02)
        parts = ranker.encode_windows(model.tokenizer, 'cobalt', documents, 32)
        self.assertGreater(len(parts), len(documents))
        self.assertTrue(all(len(part.ids) <= 32 for _, part in parts))
        self.assertEqual({index for index, _ in parts}, set(range(len(documents))))

    def test_repeated_calls_reset_tokenizer_state_and_bound_queries(self):
        model = self.fixture()
        expected = model.rank('cobalt', ['amber ' * 70 + 'target'])
        model.rank('cobalt amber', ['target ' * 50])
        self.assertEqual(model.rank('cobalt', ['amber ' * 70 + 'target']), expected)
        with self.assertRaisesRegex(ValueError, 'too long'):
            model.rank('cobalt ' * 20, ['amber target'])
        for query, documents in [('', ['cobalt']), ('a' * 1001, ['cobalt']), ('cobalt', []),
                                 ('cobalt', ['amber'] * 81), ('cobalt', ['a' * 40001])]:
            with self.assertRaises(ValueError):
                model.rank(query, documents)

    def test_incomplete_or_nonfinite_scores_are_errors(self):
        model = self.fixture()
        for output in [model.np.array([]), model.np.array([[float('nan')]])]:
            model.session.run = lambda _outputs, _arrays: [output]
            with self.assertRaises(ValueError):
                model.rank('cobalt', ['amber'])
