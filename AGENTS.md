# Source Search

Keep source access read-only. Do not add account exports, source writes, permission changes, implicit indexing, or background schedules without an explicit request. Preserve fixed command arguments and no-send guards.

CLI and MCP share the same runtime. Preserve explicit source opt-in, attribution, bounded output, partial failures and continuation. Source restrictions apply to direct reads, groups and cached projections.

Use invented data in tests. Keep credentials, local configuration, source records, indexes and live samples outside Git. Run `bun run check`, `bun test` and the Python suite after relevant changes. Never run tests against a contributor's real accounts.

Do not use subagents or Compound Engineering skills unless the user asks.
