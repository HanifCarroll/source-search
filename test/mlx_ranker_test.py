import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile

spec = importlib.util.spec_from_file_location('mlx_ranker', Path(__file__).parents[1] / 'src/search/qmd/mlx_ranker.py')
ranker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ranker)


class RankingBatchesTest(unittest.TestCase):
    def test_every_candidate_is_kept_once_and_padding_is_bounded(self):
        rows = [[i] * length for i, length in enumerate([4096, 300, 900, 303, 301, 2000, 302])]
        groups = list(ranker.batches(rows))
        self.assertEqual(sorted(i for group in groups for i in group), list(range(len(rows))))
        for group in groups:
            self.assertLessEqual(len(group), 4)
            self.assertLessEqual(max(len(rows[i]) for i in group) * len(group) - sum(len(rows[i]) for i in group), 512)
        self.assertIn([0], groups)

    def test_empty_and_equal_length_inputs(self):
        self.assertEqual(list(ranker.batches([])), [])
        self.assertEqual(list(ranker.batches([[1]] * 7)), [[0, 1, 2, 3], [4, 5, 6]])


@unittest.skipUnless(importlib.util.find_spec('mlx') and importlib.util.find_spec('mlx_lm'), 'optional MLX environment not installed')
class MlxExecutionTest(unittest.TestCase):
    def setUp(self):
        import mlx.core as mx
        self.device = mx.default_device()
        mx.set_default_device(mx.cpu)

    def tearDown(self):
        import mlx.core as mx
        mx.set_default_device(self.device)

    def fixture(self):
        import mlx.core as mx
        mx.random.seed(7)
        def matrix(shape):
            return (mx.random.normal(shape) * .1).astype(mx.float16)
        weights = {'token_embd.weight': matrix((32, 32)), 'output_norm.weight': mx.ones((32,)),
                   'cls.output.weight': matrix((2, 32))}
        for name, shape in {'attn_q': (32, 32), 'attn_k': (32, 32), 'attn_v': (32, 32),
                            'attn_output': (32, 32), 'ffn_gate': (64, 32),
                            'ffn_up': (64, 32), 'ffn_down': (32, 64)}.items():
            weights['blk.0.' + name + '.weight'] = matrix(shape)
        for name, size in {'attn_norm': 32, 'ffn_norm': 32, 'attn_q_norm': 16, 'attn_k_norm': 16}.items():
            weights['blk.0.' + name + '.weight'] = mx.ones((size,))
        meta = {'general.architecture': 'qwen3', 'general.file_type': 1,
                'qwen3.classifier.output_labels': ['yes', 'no']}
        for name, value in {'embedding_length': 32, 'block_count': 1, 'feed_forward_length': 64,
                            'attention.head_count': 2, 'attention.head_count_kv': 2,
                            'attention.key_length': 16, 'context_length': 4096,
                            'attention.layer_norm_rms_epsilon': 1e-6, 'rope.freq_base': 1000000}.items():
            meta['qwen3.' + name] = value
        return weights, meta

    def test_float32_norm_weights_do_not_promote_the_transformer(self):
        import mlx.core as mx
        with patch.object(ranker, 'read_gguf', return_value=self.fixture()):
            model, _ = ranker.load_model('invented.gguf')
        self.assertEqual(model.layers[0].input_layernorm.weight.dtype, mx.float32)
        result = model(mx.array([[1, 2, 3]]))
        mx.eval(result)
        self.assertEqual(result.dtype, mx.float16)

    def test_padding_and_length_sorting_preserve_each_document_score(self):
        rows = [[1, 2, 3], [2, 3, 4, 5, 6, 7], [3]]
        with patch.object(ranker, 'read_gguf', return_value=self.fixture()):
            together = ranker.rank('invented.gguf', rows)
            separate = [ranker.rank('invented.gguf', [row])[0] for row in rows]
        for actual, expected in zip(together, separate):
            self.assertAlmostEqual(actual, expected, places=5)

    def test_gguf_loading_preserves_model_bytes_and_cache_identity(self):
        import gguf
        import numpy as np
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'invented.gguf'
            writer = gguf.GGUFWriter(str(path), 'qwen3')
            writer.add_file_type(1)
            writer.add_tensor('invented.weight', np.ones((2, 32), dtype=np.float16))
            writer.write_header_to_file(); writer.write_kv_data_to_file(); writer.write_tensors_to_file(); writer.close()
            path.chmod(0o400)
            before, original = path.stat(), path.read_bytes()
            weights, metadata = ranker.read_gguf(str(path))
            self.assertEqual(weights['invented.weight'].shape, (2, 32))
            self.assertEqual(metadata['general.architecture'], 'qwen3')
            self.assertEqual(path.read_bytes(), original)
            after = path.stat()
            self.assertEqual((before.st_mtime_ns, before.st_ctime_ns, before.st_size),
                             (after.st_mtime_ns, after.st_ctime_ns, after.st_size))

    def test_converted_weights_are_reused_until_the_original_changes(self):
        with tempfile.TemporaryDirectory() as root:
            original = Path(root) / 'invented.gguf'
            original.write_bytes(b'invented model identity')
            cache = Path(root) / 'cache'
            with patch.object(ranker, 'read_gguf', return_value=self.fixture()) as reader:
                first, _ = ranker.cached_gguf(str(original), cache)
                second, _ = ranker.cached_gguf(str(original), cache)
                self.assertEqual(reader.call_count, 1)
                self.assertEqual(first['cls.output.weight'].tolist(), second['cls.output.weight'].tolist())
                original.write_bytes(b'replaced model identity')
                ranker.cached_gguf(str(original), cache)
                self.assertEqual(reader.call_count, 2)
