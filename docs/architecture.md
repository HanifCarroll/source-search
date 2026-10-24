# Project architecture

Source Search has one read interface: `createRuntime(config)` supplies source status, search, and record reads. CLI and MCP call that interface. Explicit maintenance builds disposable projections; retrieval does not start maintenance.

```
src/
  application/       Source registration, request orchestration, catalogue, previews
  interfaces/        CLI, guided setup, diagnostics, MCP transport, runtime reload
  domain/            Record/query contracts, matching, identity, pagination, presentation
  platform/          Configuration, private storage, files, SQLite snapshots
  formats/           HTML, MIME, calendar and YAML format adapters
  sources/
    mail/            Shared mail records, JMAP/IMAP connectors, legacy CLI adapters
    tasks/           Shared task records and app-specific task providers
    browser/         Firefox/Safari store schemas and shared profile retrieval
    messages/        Messages queries, attributed-body decoding and timestamps
    local/           Journals, local databases, PIM, browser metadata
    archives/        Export indexing, original reads, per-export interpretation
    agent-history/   CASS search and original conversation reads
  search/
    library/         Projection store, ranked discovery, provenance checks
    qmd/             Vault adapter and isolated public QMD SDK worker
  maintenance/
    library-sync.ts  Explicit projection orchestration
    refresh.py       Existing optional refresh process
    documents/       Inventory, format readers, incremental pipeline, worker CLI
    embeddings/      Compatibility launcher for managed SDK embedding
  vendor/            Self-contained upstream-derived parsers and CASS protocol code
```

The four files directly in `src/` are compatibility entry points. `cli.ts`, `mcp.ts`, and `library-sync.ts` preserve installed command paths. `api.ts` lets an already-running gateway reload the reorganized implementation. They contain no business logic. The launchers in `scripts/` serve the same purpose for existing maintenance jobs.

## Dependency rules

`domain` and `platform` do not import source adapters, search, application, interfaces, or maintenance. They share the contracts and identity primitives that let every adapter return the same record and page shapes. The low-level vendor parsers are independent of the application.

`application/source-access.ts` binds each source's status, native search, and original read in one registration per configured instance. It owns source checks, routing, the per-request mail preview allowance, and context retrieval. A new source cannot silently fall through to another source's implementation.

`application/runtime.ts` orchestrates requests: it expands groups, contains individual source failures, budgets combined results, paginates text, and writes requested previews. It calls source access through three operations: status, a search session, and an original read. CLI and MCP share this runtime; CLI additionally imports explicit maintenance commands.

`platform/source-settings.ts` validates source definitions and derives groups. `domain/source-catalog.ts` resolves instance IDs to adapter kinds and retains compatibility aliases for old references. Mail, Markdown and supported local database adapters receive the instance ID throughout search, pagination, indexing and reads. Capability checks depend on the adapter kind; references and QMD collections use the instance ID. The remaining adapters are bound to per-instance resolved configuration at registration. Their source IDs and continuation tokens are mapped at this boundary; aggregate library/documents retain their fixed IDs. Named archive and vault instances get separate indexes.

`domain/source-policy.ts` defines which sources can use library projections, how context participates in continuation, and which search routes have item-level cursors. Validation, routing, the catalogue, and maintenance use these same decisions. CASS context is part of the record body and must remain identical across continuation pages; other sources return neighboring records separately, on the first page.

Library provenance validation uses original reads directly. It never recursively calls the public, formatted `read_record` response. A valid short library section can therefore be read even when an original has metadata too large for the response budget. Original version and enabled-source checks still apply.

Presentation is a pure record-to-response transformation. Source adapters gather current availability information, such as whether a Chrome download still exists. That availability does not become part of the original record's version. Adapter identity is separate from a record version, so moving settings into an explicit source definition does not change unchanged originals. Cache guards bind mail to its provider/account and databases to their selected locations. Shared SQLite snapshots and column checks live in `platform/sqlite.ts`; Chrome and WhatsApp do not depend on Messages internals.

Maintenance may use source readers and projection storage. The read interface cannot import maintenance. `test/architecture.test.ts` checks these import directions, runtime cycles, the retrieval graph, and the absence of direct file, network, or process access in domain modules. Put new behavior in its owning module rather than adding a generic shared helper file.

## Search engines

CASS owns agent-history retrieval. QMD owns vault and library ranking. The QMD subprocess runner accepts a typed request containing the target (`vault` or `library`), mode, query, and optional collection. It selects the database and constructs fixed command arguments itself, keeping process details, time limits, and output budgets out of both adapters. It does not infer the target from an index name or parse a caller-built command line. All three search modes, collection updates and embeddings use the public `@tobilu/qmd` SDK. The dependency is installed with the application. Collections come directly from source configuration or enabled library projections. An isolated Bun process bounds model lifetime, output and time; native diagnostics stay off MCP stdout. QMD owns chunking, ranking and embedding batches. Source Search owns source selection, original-reference validation and response budgets.

Current QMD indexes retain literal filenames. The vault reader resolves legacy normalized references to their unchanged originals, so saved references survive the index upgrade. The metadata reads used for provenance remain in the vault/library adapters; no internal QMD modules are imported. Index refresh checks collection roots before updating and reports skipped files.

## Document maintenance

`inventory.py` locates configured files and attachments and retains source signatures and original locators. `formats.py` handles PDF, office documents, HTML, images, and media. `pipeline.py` owns incremental reuse, retry state, work budgets, and the private catalogue. `cli.py` runs each conversion in a resource-bounded worker.

Book formats such as EPUB and MOBI are excluded before cached text can be reused. Images are converted to RGB PNG before OCR, including GIF frames. Media is probed before transcription. Empty extraction and media without audio are recorded as skips with reasons. Converter crashes and malformed documents remain failures. Extractor versions invalidate old failure backoffs without reprocessing every successful record.

Original files, account configuration, source samples, model files, and generated indexes live outside the repository. The extractor and projection store retain original references for subsequent reads.

## Verification

Run `bun run check`, `bun test`, `bun run demo`, and `bun run test:python` in an environment with the locked extraction dependencies. Tests use invented records. Live source checks are a separate installation audit and their receipts stay private. The GitHub workflow runs tests on Linux and macOS.

Native database projections carry a version as well as a source fingerprint. Changing how stored text is interpreted therefore refreshes unchanged databases too. WhatsApp reads include stored photo, video and GIF captions; filenames and link-preview titles are not treated as authored captions. Coverage counts distinguish entries with searchable text from entries without supported text in the local store. Library embedding warnings apply only to the selected sources.

## Format parsing

`formats/` contains pure text-format adapters: HTML conversion, MIME parsing, calendar dates and YAML frontmatter. Source adapters choose records and attach provenance; format adapters handle the shared syntax. Calendar dates use ICAL.js for calendar-local VTIMEZONE definitions and Temporal for IANA identifiers. No process-global timezone registry is changed.

The Takeout ZIP wrapper retains application limits and stable entry hashes around zip.js. WhatsApp's source module owns its optional native-table joins and structured-message projection. Polls use a restricted protobuf schema; contact text uses ICAL's vCard parser. Changes to these projections invalidate the corresponding maintenance caches. The MCP runtime fingerprint includes package.json and bun.lock so dependency-only updates also rebuild the retrieval bundle. Transport dependencies load when the client reconnects.

The ZIP adapter keeps strict archive checks enabled. It validates redundant optional ZIP64 footer values before requesting ZIP64 interpretation from zip.js; original bytes and hashes are preserved. Library status includes failed maintenance stages even when an older searchable projection remains available.

## Mail connectors

`mail/index.ts` owns record formatting, source opt-in and continuation. JMAP and IMAP implement the same small search/read/thread/attachment interface in `mail/types.ts`. JMAP uses bounded HTTP requests and validates protocol responses; IMAP uses ImapFlow for connections, mailbox locks, UID search and MIME part fetching. `platform/credentials.ts` resolves private credentials for mail and task providers at connection time. `legacy.ts` retains the existing Gmail and mailbridge commands.

Identity is separate from transport. JMAP retains provider email IDs. IMAP uses account-wide server IDs when available, otherwise mailbox path plus UIDVALIDITY and UID. Cache scopes bind mail to its configured account, endpoint and folder selection. Provider errors cannot become successful empty scans that would prune the library. The Dovecot integration test runs independently of the protocol fixtures and is included in Linux CI.

## Task connectors and categories

`tasks/model.ts` defines a task and a small provider interface: synchronize a snapshot/checkpoint, read a current original, and optionally discover lists. Todoist, TickTick, Apple Reminders and Microsoft To Do own their transport interpretation and coverage. Things retains its existing record bodies and versions. The shared task adapter owns native search, pagination and original version checks; `maintenance/tasks.ts` publishes snapshots and updates the library through its normal changed-record path. Adding another task app does not add a new search route or group. JSON files use the same record model.

The macOS helper reads Reminders through EventKit and marks a complete snapshot explicitly. Microsoft uses Graph task deltas and paginated list inventories, with collection-bound continuation links. Its OAuth implementation delegates authentication and refresh to MSAL; explicit CLI login is separate from silent retrieval. Authentication caches live outside task checkpoints and disposable search caches.

Records and checkpoints commit together after a complete provider pass. Per-source locks serialize writers and recover after process failure. Credentials are resolved at request time and never stored in checkpoints. New task references bind the provider, selected files/projects and account identity, excluding credential references so token rotation preserves saved references. Existing Things archive references retain their original versions. Failed syncs retain records and report their stale status.

Categories describe user-facing data; adapters describe formats and transports. `all-calendars` can combine native macOS events with iCalendar files, `all-contacts` can combine native contacts with vCards, and browser categories span Chromium, Firefox and Safari profiles. Firefox and Safari share profile selection, pagination, current reads and reference validation; their store module owns table schemas, timestamps and bookmark formats. Safari plist decoding uses macOS on bounded bytes without modifying the source. An adapter alias does not claim support for a different storage format. Source IDs remain the stable identity and access boundary.
