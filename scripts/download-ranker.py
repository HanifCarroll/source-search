"""Explicit installer for the pinned multilingual cross-encoder; no source data."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import sys

REPOSITORY = 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1'
REVISION = '1427fd652930e4ba29e8149678df786c240d8825'
CHECKSUMS = {
    'config.json': 'cc2cfe51aa3fd759d21d21acf5dfd6994aa67a3c9210636d22e143699d336c77',
    'tokenizer.json': '62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626',  # gitleaks:allow public model file SHA-256
    'onnx/model_qint8_arm64.onnx': '1825907d6c1a9001ff78124780bbde20a614a8c3df3b63409cf3c72c6fe5c8b4',
    'onnx/model_quint8_avx2.onnx': '6c2513767fb63d008a4377bef7a7a3555433d9436342bb53e35a3a72ffc52d4b',
    'onnx/model.onnx': '3e9a03ed1e966f7c5288dd4230e3d6a9bf5e3a170a06f1f4241c5bca12c6487c',
}


def model_file(machine):
    return ('onnx/model_qint8_arm64.onnx' if machine.lower() in ('arm64', 'aarch64') else
            'onnx/model_quint8_avx2.onnx' if machine.lower() in ('x86_64', 'amd64') else 'onnx/model.onnx')


def main():
    from huggingface_hub import snapshot_download
    os.umask(0o077)
    filename = model_file(platform.machine())
    files = ['config.json', 'tokenizer.json', filename]
    directory = Path(snapshot_download(REPOSITORY, revision=REVISION, allow_patterns=[*files, 'README.md'], token=False))
    for filename_to_check in files:
        with (directory / filename_to_check).open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != CHECKSUMS[filename_to_check]:
                raise ValueError('Downloaded model checksum does not match: ' + filename_to_check)
    settings = {'engine': 'onnx', 'python': sys.executable, 'directory': str(directory), 'file': filename,
                'maxTokens': 512, 'threads': 4, 'batchSize': 4}
    spec = importlib.util.spec_from_file_location('ranker', Path(__file__).parents[1] / 'src/search/qmd/onnx_ranker.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scores = module.Ranker(settings).rank('How do I reset my password?',
        ['To reset your password, contact the help desk.', 'The gardener watered the plants.'])
    if scores[0] <= scores[1]:
        raise ValueError('Model installation did not pass the sample ranking check')
    print(json.dumps(settings))


if __name__ == '__main__':
    main()
