# Project architecture

Source Search has one application interface: `createRuntime(config)` supplies source retrieval, evidence-based context, deliberate local memory, and change feeds. CLI and MCP call that interface. Explicit maintenance builds disposable projections; retrieval does not start maintenance or save memories.

```
src/
  application/       Source registration, request orchestration, catalogue, previews
  interfaces/        CLI, guided setup, diagnostics, MCP transport, runtime reload
  domain/            Record/query contracts, matching, identity, pagination, presentation
  platform/          Configuration, private storage, snapshots, memory revisions/backup
  formats/           HTML, MIME, calendar and YAML format adapters
  sources/
    mail/            Shared mail records, JMAP/IMAP connectors, legacy CLI adapters
    tasks/           Shared task records and app-specific task providers
    sync/            Provider contract, scoped snapshots, search and paging
    browser/         Firefox/Safari store schemas and shared profile retrieval
    messages/        Messages queries, attributed-body decoding and timestamps
    local/           Journals, local databases, PIM, browser metadata
    archives/        Export indexing, original reads, per-export interpretation
    agent-history/   CASS search and original conversation reads
  search/
    library/         Projection store, ranked discovery, provenance checks
    qmd/             Vault adapter and isolated public QMD SDK worker
  maintenance/
    sources.ts       Task and connected-source synchronization
    snapshots.ts     Atomic source snapshot/checkpoint writes
    library-sync.ts  Explicit projection orchestration
    refresh.py       Independent source-sync and optional index workers
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

Maintenance may use source readers and projection storage. The read interface cannot import maintenance. The source-sync import graph cannot load search modules. The optional refresh process runs snapshot sync independently of indexing and model work, using the same CLI commands as manual maintenance. `test/architecture.test.ts` checks these import directions, runtime cycles, the retrieval graph, and the absence of direct file, network, or process access in domain modules. Put new behavior in its owning module rather than adding a generic shared helper file.

## People, projects and context

`domain/context.ts` owns mapping validation and exact relationship matching. `contextEntities` in private configuration is the source of truth for confirmed people/project mappings, saved references, and explicit source queries. Editing or removing a mapping changes the next request; there is no second registry or inferred relationship store. Email domains are case-normalized; local parts, aliases and provider IDs are kept exact. International phone formatting is normalized without guessing a country. Shared identifiers remain ambiguous.

Providers attach `RecordData.identifiers` from structured headers, participants and native IDs. They never extract identities from arbitrary record text. These derived fields, like normalized task fields, sit outside the original content version. Existing references remain stable. Ordinary search/read packets omit participant arrays; `read_record` with `details:true` exposes them for configuration.

`application/context.ts` coordinates existing original reads and searches through two injected operations. It owns bounded meeting/project retrieval, per-request read deduplication, evidence attribution, and partial results. It has no provider registry, model dependency, persistence or maintenance side effects. `runtime.ts` binds it to the same source access and search behavior used by the ordinary tools. The calling agent interprets the evidence; Source Search does not turn text into asserted decisions or commitments.

Context packets distinguish configured record/identifier links from saved-query candidates. They retain source coverage, original-read failures, ambiguous links, and search continuation tokens. A meeting anchor must still exist at the saved version. `coverage.planComplete` describes completion of the configured retrieval plan only. `library` and `documents` remain discovery projections; context uses original source references to avoid treating a projection as independent evidence.

## Durable continuity

`domain/memory.ts` defines deliberate statements, correction links, outcome attestations and revision requests. `application/memory.ts` checks selected original evidence through the existing reader, binds it to its source selection, and exposes revisions and active corrections. An evidence read establishes that a pinned record/quote was available at that time; it does not establish the truth of the authored claim. Verification remains an explicit, attributed attestation.

`platform/memory-store.ts` owns one durable SQLite database outside cache roots. An immediate transaction commits the immutable revision and operation receipt together. The revision sequence is also the memory feed, avoiding a second write or reconciliation process. Expected revisions prevent lost updates; a unique operation ID makes an uncertain retry return its original receipt. Historical reads, list pagination and exports use committed revisions. Export reads one transaction; restore validates its checksum, schema and history before writing into an empty destination and starts a new feed identity. Private backups retain authored content and evidence even when a source is disabled. Normal tools hide disabled or reselected evidence; re-enabling the same selection makes it readable again.

`platform/record-store.ts` appends source change events in the same transaction as snapshot records and checkpoints. Initialization and changed selections produce baseline resets; unchanged observations produce no events. Added/updated/removed events describe selected snapshots, not all changes in a provider. The source feed stays with the disposable record cache; its identity and selected scopes are part of each cursor. Cleanup or replacement requires a rescan, never silent continuation across lost history. Direct readers commit reference/fingerprint inventories to the same ledger; CASS reports whole-index resets and QMD tracks selected indexed documents. Neither feed starts a watcher, sync, or external action.

The runtime composes these small owners without a graph store, model, queue or second provider registry. Context assembly remains read-only; callers can separately retrieve memories for its configured entity ID. Only `write_memory` mutates durable memory through MCP. File export/restore remains explicit CLI maintenance.

## Search engines

CASS owns agent-history retrieval. QMD owns vault and library ranking. The QMD subprocess runner accepts a typed request containing the target (`vault` or `library`), mode, query, and optional collection. It selects the database and constructs fixed command arguments itself, keeping process details, time limits, and output budgets out of both adapters. It does not infer the target from an index name or parse a caller-built command line. All three search modes, collection updates and embeddings use the public `@tobilu/qmd` SDK. The dependency is installed with the application. Collections come directly from source configuration or enabled library projections. An isolated Bun process bounds model lifetime, output and time; native diagnostics stay off MCP stdout. QMD owns chunking, ranking and embedding batches. Source Search owns source selection, original-reference validation and response budgets.

Current QMD indexes retain literal filenames. The vault reader resolves legacy normalized references to their unchanged originals, so saved references survive the index upgrade. The metadata reads used for provenance remain in the vault/library adapters; no internal QMD modules are imported. Index refresh checks collection roots before updating and reports skipped files.

## Document maintenance

`inventory.py` locates configured files and attachments and retains source signatures and original locators. `formats.py` handles PDF, office documents, HTML, images, and media. `pipeline.py` owns incremental reuse, retry state, work budgets, and the private catalogue. `cli.py` runs each conversion in a resource-bounded worker.

Book formats such as EPUB and MOBI are excluded before cached text can be reused. Images are converted to RGB PNG before OCR, including GIF frames. Media is probed before transcription. Empty extraction and media without audio are recorded as skips with reasons. Converter crashes and malformed documents remain failures. Extractor versions invalidate old failure backoffs without reprocessing every successful record.

Original files, account configuration, source samples, model files, and generated indexes live outside the repository. The extractor and projection store retain original references for subsequent reads.

## Verification

For an existing installation, see [Updating an installation](updating.md) before pulling new code or changing dependencies.

```sh
bun run check
bun test
python -m unittest discover -s test -p '*_test.py'
bun audit
# Independent-server test (Docker and openssl):
bun test/imap-server.integration.ts
```

Install the [extraction requirements](maintenance.md#document-extraction) in a dedicated virtual environment before running Python extraction tests. Tests use invented records and mocked providers. CI checks Linux and macOS. Keep live installation checks and their receipts outside Git. Before publishing, review the diff, run the demo and dependency audit, and scan Git history for secrets.

Start changes in the owning module; top-level entry points stay stable for installed clients.

Native database projections carry a version as well as a source fingerprint. Changing how stored text is interpreted therefore refreshes unchanged databases too. WhatsApp reads include stored photo, video and GIF captions; filenames and link-preview titles are not treated as authored captions. Coverage counts distinguish entries with searchable text from entries without supported text in the local store. Library embedding warnings apply only to the selected sources.

## Format parsing

`formats/` contains pure text-format adapters: HTML conversion, MIME parsing, calendar dates and YAML frontmatter. Source adapters choose records and attach provenance; format adapters handle the shared syntax. Calendar dates use ICAL.js for calendar-local VTIMEZONE definitions and Temporal for IANA identifiers. No process-global timezone registry is changed.

The Takeout ZIP wrapper retains application limits and stable entry hashes around zip.js. WhatsApp's source module owns its optional native-table joins and structured-message projection. Polls use a restricted protobuf schema; contact text uses ICAL's vCard parser. Changes to these projections invalidate the corresponding maintenance caches. The MCP runtime fingerprint includes package.json and bun.lock so dependency-only updates also rebuild the retrieval bundle. Transport dependencies load when the client reconnects.

The ZIP adapter keeps strict archive checks enabled. It validates redundant optional ZIP64 footer values before requesting ZIP64 interpretation from zip.js; original bytes and hashes are preserved. Library status includes failed maintenance stages even when an older searchable projection remains available.

## Mail connectors

`mail/index.ts` owns record formatting, source opt-in and continuation. JMAP and IMAP implement the same small search/read/thread/attachment interface in `mail/types.ts`. JMAP uses bounded HTTP requests and validates protocol responses; IMAP uses ImapFlow for connections, mailbox locks, UID search and MIME part fetching. `platform/credentials.ts` resolves private credentials for mail and task providers at connection time. `legacy.ts` retains the existing Gmail and mailbridge commands.

Identity is separate from transport. JMAP retains provider email IDs. IMAP uses account-wide server IDs when available, otherwise mailbox path plus UIDVALIDITY and UID. Cache scopes bind mail to its configured account, endpoint and folder selection. Provider errors cannot become successful empty scans that would prune the library. The Dovecot integration test runs independently of the protocol fixtures and is included in Linux CI.

## Task connectors and categories

`tasks/model.ts` defines a task and a small provider interface: synchronize a snapshot/checkpoint, read a current original, and optionally discover lists. Todoist, TickTick, Apple Reminders and Microsoft To Do own their transport interpretation and coverage. Things retains its existing record bodies and versions. The shared snapshot module owns native search, pagination and original version checks. `maintenance/sources.ts` routes connected snapshots and direct observations to their respective writers. `maintenance/snapshots.ts` owns locks, atomic checkpoint publication and failed-sync retention. Library maintenance separately publishes the committed records, so projection failure cannot roll back a provider checkpoint. Adding another task app does not add a new search route or group. JSON files use the same record model.

Task and connected-source snapshots use `platform/record-store.ts`: one private `records.sqlite` in `libraryRoot`, independent of library indexing or models. Each source has its own scope, records and provider checkpoint. A short SQLite transaction commits the complete selected inventory and checkpoint together; unchanged rows are reused, missing rows are removed, and failed writes roll back. Network requests happen outside the transaction, under a per-source synchronization lock. Reads use a transaction so records and state come from the same snapshot. The cache facade selects the legacy path from the source adapter and imports old JSON snapshots during explicit synchronization. It verifies records and checkpoints before deleting the replaced file; retrieval can read an unmigrated snapshot without writing.

`domain/task-fields.ts` owns task field normalization; `domain/snapshot-query.ts` owns complete-snapshot filtering, counts and pagination for tasks and every connected category. Provider readers attach a small structured view while retaining original bodies and reference versions. Task queries reuse text/section matching, filter the selected snapshot, count matches before paging and qualify the result with snapshot coverage. Existing Things archives use the same query code against their original export. Query cursors bind filters, original versions, derived fields and coverage windows; refresh timestamps and provider ordering alone do not invalidate them. Calendar ranges match overlapping events, with exclusive end times. Undated contacts and repository files use relevance ordering. Direct and streaming readers keep their bounded candidate scans in `domain/pages.ts`. Provider-specific formats stay in their readers, and the record store does not depend on task semantics.

The macOS helper reads Reminders through EventKit and marks a complete snapshot explicitly. Microsoft uses Graph task deltas and paginated list inventories, with collection-bound continuation links. Its OAuth implementation delegates authentication and refresh to MSAL; explicit CLI login is separate from silent retrieval. Authentication caches live outside task checkpoints and disposable search caches.

Records and checkpoints commit together after a complete provider pass. Per-source locks serialize writers and recover after process failure. Credentials are resolved at request time and never stored in checkpoints. New task references bind the provider, selected files/projects and account identity, excluding credential references so token rotation preserves saved references. Existing Things archive references retain their original versions. Failed syncs retain records and report their stale status.

Categories describe user-facing data; adapters describe formats and transports. `all-calendars` can combine native macOS events with iCalendar files, `all-contacts` can combine native contacts with vCards, and browser categories span Chromium, Firefox and Safari profiles. Firefox and Safari share profile selection, pagination, current reads and reference validation; their store module owns table schemas, timestamps and bookmark formats. Safari plist decoding uses the plist library on bounded bytes without modifying the source. An adapter alias does not claim support for a different storage format. Source IDs remain the stable identity and access boundary.

Google authentication uses the official Google Auth Library with PKCE and a loopback callback for explicit login. Microsoft uses MSAL with source-specific scopes. Both store private account-bound refresh state outside disposable indexes; retrieval never opens an interactive login. Shared HTTP reads bound deadlines, response sizes, origins and redirects, while provider modules own collection-specific continuation and response validation.

## Connected providers

Provider modules follow the data they supply: `sources/pim/` for calendars and contacts, `notes/` for Notion, `files/` for Drive and OneDrive, `repositories/` for repository files, `issues/` for GitHub and Linear, and `chat/` for Slack. Tasks and connected sources share `sources/sync/` contracts, pagination and snapshot retrieval; `maintenance/snapshots.ts` owns atomic writes, locking and checkpoint advancement. It has no search dependency. Library maintenance consumes its committed snapshots; synchronization works with the library and models disabled. A provider returns a complete selected snapshot even when its upstream fetch is incremental. Failed scans cannot publish partial state. Runtime search reads snapshots and original reads call the provider; retrieval never invokes maintenance.

`platform/source-auth.ts` selects provider scopes, while the Google and Microsoft SDKs own authorization and token refresh. Provider modules receive a read transport and contain no configuration or credential persistence. Source identities include account and collection selection while excluding replaceable credential locators. New providers register in one factory and reuse category routing, search, retention and synchronization.

Repository providers implement the same snapshot/read/discovery contract. GitHub resolves a selected branch to an immutable commit and tree, then reuses text by blob revision. The file identity contains the repository, selected branch mode and path. Its version binds the account, API endpoint, repository ID, resolved branch, path and blob; it does not include unrelated files or the whole selected-repository list. This preserves unchanged file references when another repository is added. Cache scope still changes with selection, so a refresh is required; current original reads enforce the configured repositories and path patterns before fetching a file. Commit-pinned opening links retain provenance without invalidating file versions on every commit.

## Direct source observations

`maintenance/direct/` composes existing readers into complete inventories. Its local, mail and index readers return references, fingerprints and coverage; they do not route through ranking or embeddings. `platform/record-store.ts` compares and commits these inventories with their change events in one transaction. Failed scans leave the previous baseline intact. Native row fingerprints include joined metadata, file stamps avoid rereading unchanged content, and original reference formats stay intact.

`maintenance/mail.ts` owns mailbox synchronization, separate from library publication. `platform/cache-db.ts` preserves the installed mailbox cache path. Zod schemas in `platform/cache-state.ts` separate mailbox checkpoints from projection status; older combined rows migrate on the next source write or publication. IMAP and JMAP validate their own checkpoint shapes before resuming. Source and library workers share a per-mailbox lock: the source worker advances provider checkpoints, and library maintenance publishes dirty committed records. A feed scan reads the committed mailbox cache, so an interrupted feed scan retries from the last observed inventory without repeating body downloads. Events describe observed states, not every intervening upstream transition. Calendar coverage changes and CASS index changes produce explicit resets.

Native source observations optionally retain decoded records for library publication. The record, fingerprint and change event commit together. Enabling this cache fills it once without resetting the change feed. `maintenance/direct-publication.ts` consumes the committed revision under the same source lock, reuses archive indexes and skips unchanged publications. Library maintenance has no separate native scanner or export parser.
