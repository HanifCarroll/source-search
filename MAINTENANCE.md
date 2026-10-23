# Optional maintenance

Maintenance runs separately from the MCP server. Run it on demand or set up a recurring job.

1. Configure absolute source and executable paths outside the checkout.
2. Enable each source. For library work also enable `libraryEnabled`, `maintenanceEnabled`, and the `library` source.
3. Build the native export index with `bun run start rebuild` if selected exports are enabled.
4. Run `bun src/library-sync.ts` to create search projections. Mail backfills continue across runs. Cached records are pruned after a successful scan.
5. Configure QMD collections to point to the generated `library/collections/ss-<source>` directories, using an index/database that matches `libraryIndex` and `libraryDatabase`. Install the exact QMD 1.0.7 adapter version and its models separately; configure `qmdPackage` and `qmdModels`.
6. Run QMD update and `node scripts/embed-library.mjs` using the installed models.

The optional `scripts/qmd-auto-refresh.py --config /absolute/config.json --state-dir /absolute/private/state` process waits for vault edits to settle, then refreshes enabled indexes. Configure `bunBinary`, `nodeBinary`, `qmdBinary`, `qmdPackage`, indexes and databases. Stop the process before purging caches or moving roots. Schedule it with your preferred service manager.

Build the optional macOS helper with `SOURCE_SEARCH_SIGNING_IDENTITY` and `SOURCE_SEARCH_BUNDLE_ID` set to your certificate and reverse-domain identifier. Configure Calendar and Contacts access in macOS privacy settings. The helper uses a private macOS responsibility API; check compatibility when upgrading macOS.
