# Optional document extraction

Document extraction is disabled until `maintenanceEnabled`, `libraryEnabled`, and the `library` and `documents` sources are explicitly enabled. Select `documentRoots` and an absolute `extractorPython` path in local configuration. Mail attachments additionally require the corresponding mail source/account; Takeout attachments require the selected, enabled Takeout source.

Create a separate Python environment and install `scripts/extraction-requirements.txt`. Do not use an environment containing credentials or unrelated application plugins. Dependency installation may use the network; extraction itself does not fetch arbitrary document URLs. Selected mail attachments are downloaded through the configured mail provider tool.

PDF text extraction and rendering use pypdfium2/PDFium; Pillow handles rendered OCR images. PyMuPDF is not required. See THIRD_PARTY.md for licenses. PDF text order and OCR accuracy still require comparison with the original.

Other formats use python-docx, Beautiful Soup, macOS textutil, configured Tesseract, or a separately installed local transcription command. Transcription uses `mlx-whisper` with an already installed `large-v3` model and offline model loading. Compatible tools and models are not bundled.

Each file runs in a separate worker with a wall-clock timeout, bounded output and CPU/file-size limits. Linux also applies an address-space limit. macOS does not have an equivalent enforced memory cap here. These controls are not a parser sandbox. Source files are capped at 250 MB; extracted text is capped at 4 MB; PDFs over 100 pages are skipped; archive and document expansion have separate bounds. OCR and transcription can be inaccurate; verify important wording against originals.

Configured folders omit hidden files, links, CSV/TSV tables and common dependency folders. Supported mail attachments may include tables. Files uploaded to ChatGPT exports are not extracted. Caches and downloaded attachments contain plaintext. Disabling a source blocks access but does not erase copies; see the README's purge procedure.
