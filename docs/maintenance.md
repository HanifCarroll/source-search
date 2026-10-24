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

The pinned QMD dependency has a Bun patch for [slow collection-scoped vector lookups](https://github.com/tobi/qmd/issues/952) and unnecessary cache clearing on unchanged updates. It uses one filtered nearest-neighbor query per collection and preserves inference caches on no-op refreshes. `bun install --frozen-lockfile` applies the patch automatically. When upgrading QMD, remove it once upstream behavior passes the vector and incremental tests and the search benchmark.

## Incremental updates

| Sources | Update behavior |
| --- | --- |
| JMAP mail | One initial inventory, then `Email/changes` for additions, updates and removals. Expired change history or changed mailbox definitions trigger a new inventory. |
| IMAP mail | Retain UIDVALIDITY and UID inventories per mailbox. Unchanged HIGHESTMODSEQ/UIDNEXT/count skips message retrieval where available. Other servers list UIDs and fetch only new envelopes and changed folder memberships. UIDVALIDITY changes reset that mailbox. |
| Gmail through `gog` | Additions history between daily full reconciliations. The supported CLI exposes only additions, so full scans remain necessary for deletions and labels. Older versions without history use paginated reconciliation. |
| Legacy mailbridge | Paginated reconciliation; unchanged message summaries reuse cached bodies. Native JMAP offers a complete change feed. |
| Messages, WhatsApp, Muesli calls | Skip unchanged database/WAL snapshots. On change, compare row fingerprints, including joined text and metadata; decode only changed rows. A complete inventory detects edits and deletions, without assuming rows are append-only. |
| Things and selected ChatGPT, Takeout, LinkedIn, X exports | Skip unchanged selected files. Parse changed exports, then update only changed records and search projections. ZIP/JSON exports do not supply a change feed, so a changed file must be parsed. |
| Vault Markdown | File-change detection and content hashes; only changed content needs new embeddings. |
| Documents and attachments | Per-file signatures reuse extraction results, including transcript sidecars and extraction settings. Changed or removed inputs update their projections. |
| Direct notes, calendar/contact files and bookmarks | Read current files on demand, with bounded reuse of unchanged small text files. They have no separate synchronization job. |
| Browser history/downloads and native Calendar/Contacts | Query the current local database or native helper on demand. No duplicate background index to synchronize. |
| Agent history | Search the existing CASS index. CASS owns its incremental ingestion; Source Search does not add another history importer or schedule. |

Mail checkpoints advance only after successfully storing the corresponding records. Interrupted pages replay. Full scans remove cached records only after completing the inventory; deltas remove explicitly identified records. The first run after this update builds native mail checkpoints without changing original references. Gmail uses its additions feed when the configured CLI provides a usable history ID.

Library publication writes changed chunks only. An unchanged projection revision skips the index scan. Index maintenance removes unused vectors, inactive index rows and unreferenced content; active documents and shared content remain. This is cache housekeeping, with no source deletion or embedding rebuild. Database files can reuse freed space; maintenance does not run a blocking `VACUUM` every cycle.

Ranked candidates are cached for 30 minutes beside each QMD index, up to 128 entries and 512 KiB per entry. Repeats and pagination reuse that ranking across gateway restarts. Content/vector revisions, source scopes, model files and dependency changes invalidate the cache. Original-record checks still run on reads, and library pages withhold changed projections. Cache files are private and included when purging managed cache roots.

Coverage reports separate `state`, `activity`, initial backfill completion and freshness. Normal refreshing does not mark a complete source as partial. Mail without a successful sync for an hour is stale; failures and pending embeddings remain visible.

## Search release benchmark

Run `bun run bench --lexical-only` for the portable MCP/cache check used by Linux and macOS CI. Before a search release, also run `bun run bench --models-from /absolute/private/config.json` with installed local models. It creates an isolated corpus of invented documents, checks exact terms and semantic paraphrases, source exclusion, ranking, repeated searches, pagination, restart reuse and invalidation after edits. It prints cold/repeat/page timings and removes its temporary index. The full benchmark performs real inference; it neither searches configured accounts nor downloads models. The large-index vector fixture separately checks collection recall and bounded SQL work.

Build the optional macOS helper with `SOURCE_SEARCH_SIGNING_IDENTITY` and `SOURCE_SEARCH_BUNDLE_ID` set to your certificate and reverse-domain identifier. Configure Calendar and Contacts access in macOS privacy settings. The helper uses a private macOS responsibility API; check compatibility when upgrading macOS.

## Document extraction

To use document extraction, enable `maintenanceEnabled`, `libraryEnabled`, and the `library` and `documents` sources. Select `documentRoots` and an absolute `extractorPython` path in local configuration. Mail attachments additionally require the corresponding mail source/account; Takeout attachments require the selected, enabled Takeout source.

Create a separate Python environment and install `scripts/extraction-requirements.txt`. Extraction reads local documents and downloads supported mail attachments through the configured native JMAP/IMAP connector or legacy provider tool. Native downloads enforce the current account and folder selection, check the parent record version, and cap each attachment at 25 MiB and each message at 250 MiB. Books stay excluded.

PDF text extraction and rendering use pypdfium2/PDFium; Pillow handles rendered OCR images.

Other formats use python-docx, Beautiful Soup, macOS textutil, configured Tesseract, or a separately installed local transcription command. Set `transcriptionBackend` and `transcriptionModel` to values supported by your installed `transcribeBinary`; models must already be installed. Model loading stays offline. Without these settings, media without an adjacent transcript is skipped. Set `ocrLanguages` to installed Tesseract language codes, such as `eng+spa` (default `eng`). Media probing uses `ffprobeBinary` to skip videos without audio before transcription. Install these tools and models separately.

Each file runs in a separate worker with a wall-clock timeout, bounded output and CPU/file-size limits. Linux also applies an address-space limit to conversion workers; native Bun connector processes use their own response and download limits because their runtime reserves a large virtual address space. macOS does not have an equivalent enforced memory cap here. Source files are capped at 250 MB; extracted text is capped at 4 MB; PDFs over 100 pages are skipped; archive and document expansion have separate bounds. OCR and transcription can be inaccurate; verify important wording against originals.

Configured folders omit hidden files, links, CSV/TSV tables and common dependency folders. Supported mail attachments may include tables. Extraction skips files uploaded to ChatGPT exports.

Book formats (EPUB, MOBI, AZW/AZW3, FB2 and DJVU) are excluded, including previously cached entries. The PDF page limit also excludes long PDFs; it is a work limit, not a reliable way to identify every book. Files with no detected text are recorded as skipped, while converter errors remain retryable failures.
