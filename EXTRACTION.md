# Optional document extraction

To use document extraction, enable `maintenanceEnabled`, `libraryEnabled`, and the `library` and `documents` sources. Select `documentRoots` and an absolute `extractorPython` path in local configuration. Mail attachments additionally require the corresponding mail source/account; Takeout attachments require the selected, enabled Takeout source.

Create a separate Python environment and install `scripts/extraction-requirements.txt`. Extraction reads local documents and downloads selected mail attachments through the configured provider tool.

PDF text extraction and rendering use pypdfium2/PDFium; Pillow handles rendered OCR images. See THIRD_PARTY.md for licenses.

Other formats use python-docx, Beautiful Soup, macOS textutil, configured Tesseract, or a separately installed local transcription command. Transcription uses `mlx-whisper` with an already installed `large-v3` model and offline model loading. Install these tools and models separately.

Each file runs in a separate worker with a wall-clock timeout, bounded output and CPU/file-size limits. Linux also applies an address-space limit. macOS does not have an equivalent enforced memory cap here. Source files are capped at 250 MB; extracted text is capped at 4 MB; PDFs over 100 pages are skipped; archive and document expansion have separate bounds. OCR and transcription can be inaccurate; verify important wording against originals.

Configured folders omit hidden files, links, CSV/TSV tables and common dependency folders. Supported mail attachments may include tables. Extraction skips files uploaded to ChatGPT exports. See SECURITY.md for cache storage and cleanup.
