# Optional maintenance

Maintenance runs separately from the MCP server. Run it on demand or set up a recurring job.

1. Configure absolute source and executable paths outside the checkout.
2. Enable each source. For library work also enable `libraryEnabled`, `maintenanceEnabled`, and the `library` source.
3. Build the native export index with `bun run start rebuild` if selected exports are enabled.
4. Run `bun run start index --library` to create and index library projections. Mail backfills continue across runs. Cached records are pruned after a successful scan.
5. For semantic search, run `bun run start models download` once, then `bun run start index --library --embed`. Existing model paths can be reused through `searchModels`.
6. For Markdown discovery sources, run `bun run start index --source <id> --embed`. Without `--source`, every enabled vault instance is refreshed. Omit `--embed` for keyword-only use.

The optional `scripts/qmd-auto-refresh.py --config /absolute/config.json --state-dir /absolute/private/state` process waits for vault edits to settle, then refreshes enabled indexes. It uses `bunBinary` and the installed Source Search checkout. It handles multiple named vaults and a library with no vault. No separate QMD executable, collection YAML, Node embedding launcher or index-name registration is required. Stop the process before purging caches or moving roots. Schedule it with your preferred service manager.

The existing `scripts/embed-library.mjs` launcher remains an alias for the managed embedding command. Both indexing and embedding use the bundled public QMD SDK. Embedding batches are bounded and already completed documents are reused on the next run.

Build the optional macOS helper with `SOURCE_SEARCH_SIGNING_IDENTITY` and `SOURCE_SEARCH_BUNDLE_ID` set to your certificate and reverse-domain identifier. Configure Calendar and Contacts access in macOS privacy settings. The helper uses a private macOS responsibility API; check compatibility when upgrading macOS.

## Document extraction

To use document extraction, enable `maintenanceEnabled`, `libraryEnabled`, and the `library` and `documents` sources. Select `documentRoots` and an absolute `extractorPython` path in local configuration. Mail attachments additionally require the corresponding mail source/account; Takeout attachments require the selected, enabled Takeout source.

Create a separate Python environment and install `scripts/extraction-requirements.txt`. Extraction reads local documents and downloads supported mail attachments through the configured native JMAP/IMAP connector or legacy provider tool. Native downloads enforce the current account and folder selection, check the parent record version, and cap each attachment at 25 MiB and each message at 250 MiB. Books stay excluded.

PDF text extraction and rendering use pypdfium2/PDFium; Pillow handles rendered OCR images.

Other formats use python-docx, Beautiful Soup, macOS textutil, configured Tesseract, or a separately installed local transcription command. Set `transcriptionBackend` and `transcriptionModel` to values supported by your installed `transcribeBinary`; models must already be installed. Model loading stays offline. Without these settings, media without an adjacent transcript is skipped. Set `ocrLanguages` to installed Tesseract language codes, such as `eng+spa` (default `eng`). Media probing uses `ffprobeBinary` to skip videos without audio before transcription. Install these tools and models separately.

Each file runs in a separate worker with a wall-clock timeout, bounded output and CPU/file-size limits. Linux also applies an address-space limit to conversion workers; native Bun connector processes use their own response and download limits because their runtime reserves a large virtual address space. macOS does not have an equivalent enforced memory cap here. Source files are capped at 250 MB; extracted text is capped at 4 MB; PDFs over 100 pages are skipped; archive and document expansion have separate bounds. OCR and transcription can be inaccurate; verify important wording against originals.

Configured folders omit hidden files, links, CSV/TSV tables and common dependency folders. Supported mail attachments may include tables. Extraction skips files uploaded to ChatGPT exports.

Book formats (EPUB, MOBI, AZW/AZW3, FB2 and DJVU) are excluded, including previously cached entries. The PDF page limit also excludes long PDFs; it is a work limit, not a reliable way to identify every book. Files with no detected text are recorded as skipped, while converter errors remain retryable failures.
