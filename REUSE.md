# Code provenance and dependencies

The initial Messages snapshot/reader code, ChatGPT export parser, Google Takeout parser/ZIP reader, CASS provider and macOS PIM helper were extracted from LifeOS revision `48a799286ee2234e109ddaf41bf9788f14e0c2cf`, then adapted for targeted retrieval. Runtime imports from the original application were removed. The copyright holder confirmed ownership and authorized these components for this MIT-licensed release.

The Messages typedstream reader uses format definitions inspected in [python-typedstream](https://github.com/dgelessus/python-typedstream/blob/main/src/typedstream/stream.py); that implementation was not copied. Tests encode invented records using the supported format subset.

Installed TypeScript dependencies are recorded in `bun.lock`. Optional extraction dependencies are recorded separately. QMD, CASS, provider CLIs, OCR/transcription tools and models are separately installed software; their licenses and supported versions must be reviewed when distributing them. This repository does not bundle those binaries, models, credentials, or application databases.

Native helper builds require the operator's own signing identity and bundle identifier. No signing certificate or inherited privacy grant is distributed.
