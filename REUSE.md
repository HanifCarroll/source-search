# Code provenance and dependencies

The initial Messages snapshot/reader code, ChatGPT export parser, Google Takeout parser/ZIP reader, CASS provider and macOS PIM helper were extracted from LifeOS revision `48a799286ee2234e109ddaf41bf9788f14e0c2cf`, then adapted for targeted retrieval. Runtime imports from the original application were removed. These components are included under the project’s MIT license.

The Messages typedstream reader uses format definitions inspected in [python-typedstream](https://github.com/dgelessus/python-typedstream/blob/main/src/typedstream/stream.py); that implementation was not copied. Tests encode invented records using the supported format subset.

Installed TypeScript dependencies are recorded in `bun.lock`. Optional extraction dependencies are recorded separately. Install QMD, CASS, provider CLIs, OCR/transcription tools and models separately. Their licenses and supported versions are listed in their own documentation.

Build native helpers with your signing identity and bundle identifier.
