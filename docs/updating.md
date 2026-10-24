# Updating an installation

Synchronized task, calendar, contact, note, file, issue, chat and repository snapshots now use a shared private SQLite store. Stop the refresh process before updating, then run `bun run start sync-sources` (or restart the existing refresher). The first sync imports each selected source's old JSON snapshot and checkpoint before contacting its provider. It verifies the imported records and removes the replaced JSON cache; a failed provider request retains the imported snapshot. Source IDs, original versions and saved references stay unchanged. Search can still read an unmigrated JSON snapshot without writing anything. Direct readers (including native macOS calendars/contacts and mail), other indexes and original files are unchanged. Restart searches with an older continuation cursor after upgrading the query implementation; saved record references are preserved. Reconnect MCP clients if upgrading from a version without the task-filter input schema. When rolling back to code that predates this store, re-sync those sources to regenerate that version's disposable JSON snapshots.

Keep the application checkout on the public repository's `main` branch. Store personal settings outside Git, normally at `~/.config/source-search/config.json`. Source files, credentials, models, databases, and caches also belong outside the checkout.

## Before updating

Record the installed commit with `git rev-parse HEAD` and back up your private configuration. Check `git status --short`; resolve local code changes before updating. Keep any older private history in a separate backup.

If you run optional maintenance, stop that existing job using the mechanism that started it. This prevents maintenance from loading a mixture of old and new code.

## Update and check

From the application checkout:

```sh
git pull --ff-only origin main
bun install --frozen-lockfile
bun run check
bun test
```

If document extraction is enabled, update its dedicated environment from the committed requirements. For example, with `uv`, replace the path below with the `extractorPython` value in your private configuration:

```sh
uv pip install --python /absolute/path/to/extract-env/bin/python \
  --require-hashes -r scripts/extraction-requirements.txt
/absolute/path/to/extract-env/bin/python -m unittest discover -s test -p '*_test.py'
```

Validate your configured settings without accessing any source:

```sh
bun -e 'import {loadConfig} from "./src/platform/config"; await loadConfig(); console.log("Configuration is valid");'
```

Set `SOURCE_SEARCH_CONFIG_FILE` for these commands if you use a different configuration location. Unknown settings and relative source paths fail validation. Keep your existing configuration; the example file is a starting point for new installations.

Restart your existing maintenance job after the checks pass. Reconnect MCP clients to load transport or dependency changes. The running MCP gateway reloads retrieval code and configuration between requests, but cannot replace its already loaded transport dependencies.

Finally, run `bun run start sources` to check the enabled sources. This performs live access checks. Verify a search and record read for the sources you use.

## Existing indexes and rollback

Source synchronization remains separate from optional library maintenance. `sync-sources` now also accepts tasks; `sync-tasks` remains available. Both commands save source snapshots without writing library projections. Run `index --library` when you want to update the combined library; `--update-only` only indexes already-published projections. The task cache migration described above needs no embedding rebuild. Restart the existing optional refresh job to load its independent source-sync worker. That worker also works with the library off; installations without configured models perform keyword indexing only.

Keep configured cache and model paths stable. Maintenance updates changed projections incrementally; lexical search may be available while their embeddings catch up.

The incremental-maintenance update needs no configuration changes or embedding rebuild. Its first pass establishes mail checkpoints, native row fingerprints and search revisions; subsequent passes reuse them. Existing mail caches remain available while that first inventory completes. Back up the index and library before the first pass, which also removes obsolete derived embeddings. See [incremental updates](maintenance.md#incremental-updates) for each connector's reconciliation behavior.

The shared task adapter and category groups need no migration of existing sources. Keep `things-archive` and its ID to retain existing references; use `tasks` for new Things, Todoist, TickTick or JSON sources. Existing `chrome-*` names continue working; `browser-*` names describe the same Chromium formats for new configurations. The vector-search performance patch needs only the locked dependency install, without rebuilding embeddings or changing models.

If `gmailBinary` points to a wrapper with a command allowlist, include the read-only `gmail history` command (`gmail.history` in `gog --enable-commands`). Without it, Gmail uses full reconciliation instead of its additions feed. Keep the wrapper's existing account routing and no-send setting.

Before adopting this release from an older private installation, configure the source paths previously supplied by defaults, mail account routing, `enabledSources`, and `maintenanceEnabled`. Existing derived records may need migration or regeneration because this release binds them to their source configuration.

If an update fails, keep maintenance stopped and return to the recorded public commit or a preserved installation. Restore matching dependencies and configuration. Restore cache snapshots only if the update changed their format. Original source files stay in place.

Search now uses the bundled public QMD SDK. Global `qmdBinary`, `qmdPackage`, and index names are no longer used. Keep the database and model paths. Set `searchModels` explicitly or retain the old `qmdModels` list until migration; old model filenames are recognized. Existing CLI, MCP and refresh launch paths remain available.

Back up old QMD databases before the first managed update. Run `index` for literal-filename indexing; old normalized vault references remain readable. Older vectors lack current model fingerprints. Rebuild them with `index --embed`, or validate and adopt them using the bundled QMD CLI's `doctor` against a private copy before replacing the cache. Never mark arbitrary vectors compatible solely by changing their model label. The original installation backup should retain both database files and configuration.

Parser upgrades also refresh WhatsApp polls/contact cards and affected export projections during the next explicit maintenance run. Existing cached mail is reformatted from saved responses. Allow the library update and embedding steps to finish before checking semantic coverage. No new source configuration is needed.

## Moving to named sources

Existing source IDs and flat configuration fields remain supported. For new settings, put repeatable integrations under `sources` and keep the same IDs during migration:

- Move each `mailAccounts` entry to `sources.<same-id>` and add `adapter: "gmail"` or `"fastmail"`.
- Move note paths to Markdown source definitions. Copy the filename pattern, date fields, content label and timezone you actually use. See the [Markdown settings](connectors.md#markdown-folders). Legacy voice/call notes used `content: "transcript"`, `reviewed: true`, and date fields `["source_started_at", "date"]`.
- Move `muesli` to `sources.calls` with `adapter: "muesli"` and `database`; move `whatsapp` to `sources.whatsapp` similarly.
- Move archive file lists to `sources.<id>.paths`, Things exports to `root` or `database`, Messages to `database`, CASS to `data`/`binary`, and vault collections to `roots`/`database`. Preserve IDs and selected locations.
- Move browser profiles to `profiles: [{"id":"work","path":"/profile/path"}]`; retain the original numeric order in `legacyProfileIds`. New references use profile IDs.
- Set `timeZone` explicitly. Older versions interpreted journal days in `America/Buenos_Aires`; new installations default to UTC. Use the old zone when preserving those dates.

Keep account values, aliases, database locations and source IDs unchanged to retain existing library identities. If switching an instance to a different account or provider, use a new ID or clear its old cache. Renaming an ID creates a new reference namespace and QMD collection; it does not migrate old references.

For media extraction without adjacent transcripts, choose `transcriptionBackend` and `transcriptionModel` explicitly. The previous choices were `mlx-whisper` and `large-v3`. Extraction remains disabled unless its sources and maintenance are enabled.

## Native mail connectors

New sources can use `jmap` or `imap` directly; see [mail setup](connectors.md#mail) for authentication and search behavior. Existing Gmail and mailbridge configurations continue working.

For an existing Fastmail source, keep its source ID, account, email and aliases, and select `adapter: "jmap"`, the provider session URL, `accountId` and private authentication. Set `recordFormat: "mailbridge-v1"` to retain the original body and metadata format used by saved references. New JMAP sources default to `complete`, which includes every text body part, CC and the message header ID.

Changing the connector changes its cache scope. Migrate an existing cache only after comparing its saved IDs and record versions against the new connection: back up the private configuration and library, stop maintenance, and rebind the verified source's scope in cached state, chunk guards and raw-response envelopes. Preserve chunk IDs, content hashes and references. Otherwise use a fresh source ID for a new cache, while keeping the old source available for existing references. Changing only the adapter field does not migrate a cache.
