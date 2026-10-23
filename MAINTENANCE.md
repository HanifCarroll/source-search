# Optional maintenance

Maintenance is separate from the read-only MCP server. Nothing in installation schedules or starts it.

1. Configure absolute source and executable paths outside the checkout.
2. Explicitly enable each source. For library work also enable `libraryEnabled`, `maintenanceEnabled`, and the `library` source.
3. Build the native export index with `bun run start rebuild` if selected exports are enabled.
4. Run `bun src/library-sync.ts` explicitly to create projections. Mail backfills are bounded and continue on later runs. Failed scans do not prune records.
5. Configure QMD collections to point to the generated `library/collections/ss-<source>` directories, using an index/database that matches `libraryIndex` and `libraryDatabase`. Install the exact QMD 1.0.7 adapter version and its models separately; configure `qmdPackage` and `qmdModels`.
6. Run QMD update and `node scripts/embed-library.mjs` explicitly. Embedding requires installed models and does not intentionally download replacements.

The optional `scripts/qmd-auto-refresh.py --config /absolute/config.json --state-dir /absolute/private/state` process debounces configured vault edits and performs library maintenance only when enabled. Its configuration must include `bunBinary`, `nodeBinary`, `qmdBinary`, `qmdPackage`, indexes and databases. Stop the process before purging caches or moving roots. No LaunchAgent is included or installed.

The optional macOS helper build requires `SOURCE_SEARCH_SIGNING_IDENTITY` and `SOURCE_SEARCH_BUNDLE_ID`. Use your own certificate and reverse-domain identity. Review OS privacy prompts yourself; retrieval does not request or reset permissions. The helper sources use a macOS private responsibility API and need separate compatibility testing on the target OS.
