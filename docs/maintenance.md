# Optional maintenance

Maintenance runs separately from the MCP server. Run it on demand or set up a recurring job.

`bun run start sync-sources [SOURCE_ID]` refreshes task/connected snapshots and direct-source change inventories. It needs `maintenanceEnabled` and selected sources; no library or models are required. `sync-tasks` remains a task-only shortcut. Connected records/checkpoints and the shared change ledger live in private `records.sqlite` under `libraryRoot`. Direct inventories retain original references and fingerprints. With library indexing enabled, native sources also retain decoded records in the same transaction; the publisher consumes those records without a second source scan. Archive publication reuses the committed export index. Mail keeps its existing resumable cache in `library.sqlite`; source synchronization owns its provider checkpoints. `index --library` refreshes sources, publishes library text and updates the keyword index; `--embed` adds embeddings. A coordinator that already ran `sync-sources` can use `index --library --skip-source-sync` to publish committed source records without contacting providers, opening native databases or reparsing exports. Run source sync first when enabling library indexing on an existing source.

1. Configure absolute source and executable paths outside the checkout.
2. Enable each source. For library work also enable `libraryEnabled`, `maintenanceEnabled`, and the `library` source.
3. Build the native export index with `bun run start rebuild` if selected exports are enabled.
4. Run `bun run start index --library` to create and index library projections. Mail backfills continue across runs. Cached records are pruned after a successful scan.
5. For semantic search, run `bun run start models download` once, then `bun run start index --library --embed`. Existing model paths can be reused through `searchModels`.
6. For Markdown discovery sources, run `bun run start index --source <id> --embed`. Without `--source`, every enabled vault instance is refreshed. Omit `--embed` for keyword-only use.

The optional `scripts/qmd-auto-refresh.py --config /absolute/config.json --state-dir /absolute/private/state` process synchronizes enabled task and connected sources in one worker and refreshes optional search indexes in another. Source sync runs even with the library disabled and continues while embeddings run or an index fails. Vault indexing waits for edits to settle. Embedding runs only when model paths are configured; without models, maintenance updates keyword indexes. It uses `bunBinary` and the installed Source Search checkout. It handles source-only setups, multiple named vaults and a library with no vault. `sources-status.json`, `status.json` (vault) and `library-status.json` in the private state directory report each worker’s latest outcome. No separate QMD executable, collection YAML, Node embedding launcher or index-name registration is required. Stop the process before purging caches or moving roots. Schedule it with your preferred service manager.

The existing `scripts/embed-library.mjs` launcher remains an alias for the managed embedding command. Both indexing and embedding use the bundled public QMD SDK. Embedding batches are bounded and already completed documents are reused on the next run.

The pinned QMD dependency has a Bun patch for [slow collection-scoped vector lookups](https://github.com/tobi/qmd/issues/952) and unnecessary inference cache clearing. It shares nearest-neighbor work across selected collections and retrieves chunk metadata through its primary key. An unfiltered lookup is accepted only when its entire candidate window belongs to the selected sources; otherwise the query is repeated with an exact source filter. Crowded or tied chunk boundaries fall back to per-collection retrieval. Models, candidate counts and ranking stay unchanged. Index edits preserve scores for unchanged text; changed text gets a new score, and retrieval still refreshes after every content/vector revision. Replacing model files clears inference caches. `bun install --frozen-lockfile` applies the patch automatically. When upgrading QMD, remove it once upstream behavior passes the vector and incremental tests and the search benchmark.

## Managed search indexes

Direct Markdown search works immediately. For ranked discovery across a folder, add a `vault` source and enable explicit maintenance:

```json
{
  "enabledSources": ["research"],
  "maintenanceEnabled": true,
  "sources": {
    "research": {"adapter": "vault", "roots": {"notes": "/absolute/path/to/notes"}}
  }
}
```

```sh
bun run start index --source research
bun run start search '{"queries":[{"source":"research","query":"example","mode":"lexical"}]}'
# Optional local semantic/hybrid search:
bun run start models download
bun run start index --source research --embed
```

`models download` downloads the embedding, expansion and reranking models (several GB) and saves their paths to private configuration. Existing installations can instead set `searchModels: {"embed":"/path/model.gguf","rerank":"/path/model.gguf","generate":"/path/model.gguf"}` to reuse installed models. The bundled native engine uses a supported GPU or CPU; its installation may need Node 20+ or native build tools on platforms without a compatible prebuilt binary. Search does not download models.

On macOS, semantic and hybrid search also require Homebrew SQLite (`brew install sqlite`) so Bun can load the vector extension. `doctor` checks for it. Direct readers and keyword search work without this dependency.

For a derived library of mail, messages and selected archives, enable `libraryEnabled`, `maintenanceEnabled`, the `library` source and each contributing source, then run `bun run start index --library --embed`. The library works without a vault. Mail backfills may need several runs; `sources` reports progress. Omit `--embed` for keyword-only indexing. Changing the embedding model requires rebuilding embeddings; old vectors are not interchangeable.

## Incremental updates

| Sources | Update behavior |
| --- | --- |
| JMAP mail | Capture the initial ID inventory before downloading bodies in resumable batches, then drain `Email/changes` for activity during the scan. Later passes retrieve additions, updates and removals. Expired change history or changed mailbox definitions trigger a new inventory. |
| IMAP mail | Retain UIDVALIDITY and UID inventories per mailbox. Unchanged HIGHESTMODSEQ/UIDNEXT/count skips message retrieval where available. Other servers list UIDs and fetch only new envelopes and changed folder memberships. UIDVALIDITY changes reset that mailbox. |
| Gmail through `gog` | Additions history between daily full reconciliations. The supported CLI exposes only additions, so full scans remain necessary for deletions and labels. Older versions without history use paginated reconciliation. |
| Legacy mailbridge | Paginated reconciliation; unchanged message summaries reuse cached bodies. Native JMAP offers a complete change feed. |
| Todoist tasks | Initial active snapshot followed by a delta, then sync-token changes for tasks, projects, sections and task comments. Completion/deletion removes tasks from the active index. |
| TickTick tasks | Complete snapshots of selected projects, followed by record/projection diffs. No change token is exposed by these endpoints. |
| Apple Reminders | Complete EventKit snapshots of selected lists, including completed reminders, followed by record/projection diffs. Incomplete or unauthorized scans retain the previous snapshot. |
| Microsoft To Do | Paginated list inventory plus per-list task deltas, with daily full reconciliation for changes omitted by the feed. Expired delta history restarts a full pass. Tenants rejecting read-only delta access use complete snapshots. Changed tasks refresh steps/linked resources; original reads always fetch current data. |
| Google Tasks | Modified-since polling with overlap, including completed, hidden and deleted tasks, plus daily full reconciliation. |
| Google calendars and contacts | Per-calendar sync tokens and People contact sync tokens; expired tokens reset the affected inventory. Calendar occurrence windows advance daily. |
| Outlook calendars and contacts | Primary-calendar and contact-folder deltas. Secondary calendars use bounded full views. Expired delta history restarts the affected inventory. |
| CalDAV and CardDAV | Server sync tokens where available, otherwise collection tags and full changed-collection reads through tsdav. |
| Notion | Selected page/data-source inventories, content revision reuse and daily full content reconciliation. |
| Drive and OneDrive | Change feeds trigger selected-folder inventory refreshes; unchanged text reuses its revision. Daily reconciliation checks moves and permission changes. |
| GitHub and Linear issues | Independent issue/comment update feeds with overlap, plus daily full reconciliation for removals and moves. |
| GitHub repository files | Check selected branch heads, inventory changed trees and download only new blob revisions. Complete trees detect deletions, renames and force pushes. Unchanged heads skip tree/blob downloads. |
| Slack | Recent history and known threads refresh each pass; daily full reconciliation covers older edits, removals and first replies to old roots within the configured window. |
| Generic task files and Things task connector | Read the selected snapshots and publish changed records only. Existing `things-archive` sources retain their export index behavior. |
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

Build the optional macOS helper with `SOURCE_SEARCH_SIGNING_IDENTITY` and `SOURCE_SEARCH_BUNDLE_ID` set to your certificate and reverse-domain identifier. Keep both stable when rebuilding. Use its explicit `authorize calendar`, `authorize contacts` or `authorize reminders` command to configure the corresponding macOS permission. Read and sync commands never request access. The helper uses a private macOS responsibility API; check compatibility when upgrading macOS.

## Document extraction

To use document extraction, enable `maintenanceEnabled`, `libraryEnabled`, and the `library` and `documents` sources. Select `documentRoots` and an absolute `extractorPython` path in local configuration. Mail attachments additionally require the corresponding mail source/account; Takeout attachments require the selected, enabled Takeout source.

Create a separate Python environment and install the locked extraction dependencies:

```sh
python3 -m venv "$HOME/.local/share/source-search/extract-env"
"$HOME/.local/share/source-search/extract-env/bin/python" -m pip install \
  --require-hashes -r scripts/extraction-requirements.txt
```

Set `extractorPython` to that environment’s absolute Python path. Reuse an existing extraction environment when updating. Extraction reads local documents and downloads supported mail attachments through the configured native JMAP/IMAP connector or legacy provider tool. Native downloads enforce the current account and folder selection, check the parent record version, and cap each attachment at 25 MiB and each message at 250 MiB. Books stay excluded.

PDF text extraction and rendering use pypdfium2/PDFium; Pillow handles rendered OCR images.

Other formats use python-docx, Beautiful Soup, macOS textutil, configured Tesseract, or a separately installed local transcription command. Set `transcriptionBackend` and `transcriptionModel` to values supported by your installed `transcribeBinary`; models must already be installed. Model loading stays offline. Without these settings, media without an adjacent transcript is skipped. Set `ocrLanguages` to installed Tesseract language codes, such as `eng+spa` (default `eng`). Media probing uses `ffprobeBinary` to skip videos without audio before transcription. Install these tools and models separately.

Each file runs in a separate worker with a wall-clock timeout, bounded output and CPU/file-size limits. Linux also applies an address-space limit to conversion workers; native Bun connector processes use their own response and download limits because their runtime reserves a large virtual address space. macOS does not have an equivalent enforced memory cap here. Source files are capped at 250 MB; extracted text is capped at 4 MB; PDFs over 100 pages are skipped; archive and document expansion have separate bounds. OCR and transcription can be inaccurate; verify important wording against originals.

Configured folders omit hidden files, links, CSV/TSV tables and common dependency folders. Supported mail attachments may include tables. Extraction skips files uploaded to ChatGPT exports.

Book formats (EPUB, MOBI, AZW/AZW3, FB2 and DJVU) are excluded, including previously cached entries. The PDF page limit also excludes long PDFs; it is a work limit, not a reliable way to identify every book. Files with no detected text are recorded as skipped, while converter errors remain retryable failures.

## Cache retention

Caches store retrieved text, attachments and previews. Disabling a source stops future access while retaining its cache. To remove cached data, stop maintenance and run `bun run start purge-cache` to preview the cleanup, then add `--apply`. The command handles the default managed cache; custom locations and backups need separate cleanup.

## Deliberate memory

Memory is local authored information: `decision`, `preference`, `commitment`, `correction` or `outcome`. Search and context tools never create it automatically. Originals remain in their apps. No additional service or model is required.

CLI commands share the MCP schemas:

| CLI | MCP | Purpose |
| --- | --- | --- |
| `memories '[JSON]'` | `list_memories` | Filter by `query` (case-insensitive substring), `kind`, `entity` or `corrects: {id, revision}`; follow `nextCursor` |
| `memory '<JSON>'` | `read_memory` | Read by `id`, optionally `revision` and `checkEvidence: true`; includes active corrections |
| `remember '<JSON>'` | `write_memory` | Create, replace or retract a memory with a reason |
| `changes '<JSON>'` | `list_changes` | Read changes since a saved cursor |

All accept JSON on stdin (`memories` defaults to an empty filter). A new memory request looks like this; generate a new UUID for each distinct operation:

```json
{
  "operationId": "9a810dac-26da-4e4a-9c33-a9af2d39e1f7",
  "reason": "The user asked to remember this preference",
  "memory": {"kind": "preference", "text": "Use concise meeting summaries."}
}
```

After an uncertain response, retry the **same input and operationId**. To edit, supply the returned `id`, `expectedRevision`, a new operation ID and the complete replacement `memory`. `REVISION_CONFLICT` means read the current revision before editing. To withdraw an entry, use `action: "retract"`, its `id`/`expectedRevision` and a reason, omitting `memory`. Retraction preserves history; normal lists exclude it. Earlier revisions remain readable.

Use `entities` for IDs from private `contextEntities`. A correction needs `corrects: {id, revision}`. It appears when reading that original revision without rewriting it; use an edit when replacing the current statement. Read full memories and their corrections before using list previews as facts. Context packets and durable memories remain separate: for a project, call `build_context`, then `list_memories` with its entity ID.

Optional `evidence` entries contain the original `{source, id, version}` reference and an optional exact `quote`. Save at most five citations. If a search preview has no version, call `read_record` first and use the returned versioned reference. Writes reopen pinned originals and check quotes. Use the original reference behind library/document hits. Some references, especially CASS query-bound references, can expire; `read_memory` with `checkEvidence: true` reports this while preserving the authored memory and its historical check time. Disabled or reselected sources hide their stored citation details in ordinary tool responses. Authored memory text remains available independently.

An outcome is a statement unless it includes `verification: {method, observation, by}` and evidence. This records the caller's explicit verification attestation and citation-check time. Source Search checks the cited record and quote, not whether they prove the outcome. Changed or missing evidence is reported separately; a failed recheck never silently rewrites history.

### Backup and restore

`memoryRoot` defaults to `~/.local/share/source-search/memory`. It must be separate from every cache path. The directory is created on the first write. Cache cleanup leaves it intact. Include it in your normal private backups, or export a portable JSON snapshot:

```sh
bun run start memory-export /absolute/private/backup/memory.json
```

Export includes all revisions, retractions, citations and retry receipts. The destination must be new; its directory must be private (0700). The export is private (0600), checksummed and limited to 60 MiB of revision data and 100,000 revisions. For a larger store use SQLite's supported backup tooling. Avoid copying an active database file without a consistent SQLite snapshot.

To recover, set `memoryRoot` in the destination config to an empty private location, then run:

```sh
bun run start memory-restore /absolute/private/backup/memory.json
```

Restore validates the format, checksum and revision history, preserves IDs and receipts, and refuses to overwrite existing memories. It starts a new feed identity; consumers must rescan. A checksum detects accidental changes, not who authored a backup. Restored verification is historical; recheck important evidence in the destination setup. Export files include the original stored evidence even if its source is currently disabled.

### Resuming changes

Call `list_changes` with `{"feed":"memory"}` or `{"feed":"sources","sources":["todo","agenda"]}`. Save the returned `cursor` **after** processing that page, including empty pages. Pass it in the next request; drain pages while `hasMore` is true. A consumer interrupted before saving its cursor may see events again, so use the returned `streamId` plus event `sequence` (or memory ID/revision) to deduplicate its own work.

The memory feed retains every deliberate revision. The source feed covers connected snapshots and direct mail, Markdown, Messages, WhatsApp, calls, browsers, native/file calendars and contacts, selected archives and QMD documents. `coverage` reports freshness, errors, strategy and record counts. Direct reads and search ranking remain unchanged. Library/documents are projections; subscribe to their contributing originals.

- JMAP/IMAP reuse provider checkpoints and confirmed removals. The Gmail CLI exposes additions; daily complete reconciliation catches deletions and other changes. A mailbox's first baseline starts only after its initial inventory finishes.
- Local databases compare consistent snapshots, decoding changed rows only. Files reuse unchanged fingerprints. Missing/inaccessible stores or incomplete scans retain the previous inventory. Export tracking covers selected files, with no account export operation.
- Native/ICS calendars cover a window anchored to the first day of the current UTC month: 180 days before and 180 after by default. Configure `changeTracking: {calendarPastDays: 30, calendarFutureDays: 180}` (at most 366 days combined). Advancing/changing that window emits one `reset`, not a series of apparent deletions. Search still accepts other date ranges.
- Vault tracking observes the selected QMD index's committed document versions. Run its ordinary index refresh to pick up original file changes. CASS exposes a committed content fingerprint, so agent history reports `granularity: "index"` and emits `reset` when it changes. Rerun relevant searches; these are not per-message events.

The first sync, an upgraded pre-existing snapshot, or a changed account/selection emits `reset`: establish a baseline with ordinary search pagination (or rerun relevant queries for ranked/index-level sources). Later events are `added`, `updated` or `removed` from the selected snapshot; removal can reflect a changed coverage window rather than upstream deletion. Events describe observations, so changes between syncs may be absent. Unchanged syncs and failed syncs add no events; failures remain in coverage. After cache cleanup or restore, `FEED_RESET` requires rescan and a fresh cursor. Changing the selected source IDs/scopes requires a new cursor. This pull interface adds no schedules or actions.
