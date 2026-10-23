# Updating an installation

Keep the application checkout on the public repository's `main` branch. Store personal settings outside Git, normally at `~/.config/source-search/config.json`. Source files, credentials, models, databases, and caches also belong outside the checkout.

## Before updating

Record the installed commit with `git rev-parse HEAD` and back up your private configuration. Check `git status --short`; resolve local code changes before updating. Keep any older private history in a separate backup.

If you run optional maintenance, stop that existing job using the mechanism that started it. This prevents maintenance from loading a mixture of old and new code.

## Update and check

From the application checkout:

```sh
git pull --ff-only origin main
bun install --frozen-lockfile --ignore-scripts
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
bun -e 'import {loadConfig} from "./src/config"; await loadConfig(); console.log("Configuration is valid");'
```

Set `SOURCE_SEARCH_CONFIG_FILE` for these commands if you use a different configuration location. Unknown settings and relative source paths fail validation. Keep your existing configuration; the example file is a starting point for new installations.

Restart your existing maintenance job after the checks pass. Reconnect MCP clients to load transport or dependency changes. The running MCP gateway reloads retrieval code and configuration between requests, but cannot replace its already loaded transport dependencies.

Finally, run `bun run start sources` to check the enabled sources. This performs live access checks. Verify a search and record read for the sources you use.

## Existing indexes and rollback

Keep configured cache and model paths stable. Maintenance updates changed projections incrementally; lexical search may be available while their embeddings catch up.

Before adopting this release from an older private installation, configure the source paths previously supplied by defaults, mail account routing, `enabledSources`, and `maintenanceEnabled`. Existing derived records may need migration or regeneration because this release binds them to their source configuration.

If an update fails, keep maintenance stopped and return to the recorded public commit or a preserved installation. Restore matching dependencies and configuration. Restore cache snapshots only if the update changed their format. Original source files stay in place.
