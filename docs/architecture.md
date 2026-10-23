# Project architecture

Source Search has one read interface: `createRuntime(config)` supplies source status, search, and record reads. CLI and MCP call that interface. Explicit maintenance builds disposable projections; retrieval does not start maintenance.

```
src/
  application/       Request routing, source catalogue, previews
  interfaces/        CLI, MCP transport, runtime reload
  domain/            Record/query contracts, matching, identity, pagination, presentation
  platform/          Configuration, private cache storage, original-file access
  sources/
    mail/            Provider commands and mail records
    messages/        Messages queries and attributed-body decoding
    local/           Journals, tasks, local databases, PIM, browser metadata
    archives/        Export indexing, original reads, per-export interpretation
    agent-history/   CASS search and original conversation reads
  search/
    library/         Projection store, ranked discovery, provenance checks
    qmd/             Vault adapter, bounded subprocess runner, hybrid ranking worker
  maintenance/
    library-sync.ts  Explicit projection orchestration
    refresh.py       Existing optional refresh process
    documents/       Inventory, format readers, incremental pipeline, worker CLI
    embeddings/      Atomic embedding batches and Node entry point
  vendor/            Self-contained upstream-derived parsers and CASS protocol code
```

The four files directly in `src/` are compatibility entry points. `cli.ts`, `mcp.ts`, and `library-sync.ts` preserve installed command paths. `api.ts` lets an already-running gateway reload the reorganized implementation. They contain no business logic. The launchers in `scripts/` serve the same purpose for existing maintenance jobs.

## Dependency rules

`domain` and `platform` do not import source adapters, search, application, interfaces, or maintenance. They share the contracts and identity primitives that let every adapter return the same record and page shapes. The low-level vendor parsers are independent of the application.

Source adapters implement native status, search, and record reads. Ranked search uses those original references to validate provenance. Application routing selects an adapter and applies shared presentation and response budgets. MCP exposes only the read interface; CLI additionally imports explicit maintenance commands.

Maintenance may use source readers and projection storage. The read interface cannot import maintenance. `test/architecture.test.ts` checks these import directions, runtime cycles, and the retrieval graph. Put new behavior in its owning module rather than adding a generic shared helper file.

## Search engines

CASS owns agent-history retrieval. QMD owns vault and library ranking. The QMD subprocess runner is shared by both adapters, keeping time and output budgets in one place. Lexical and semantic requests use the installed CLI. Hybrid requests use the version-pinned Node worker embedded in the Bun runtime, so reloads do not depend on temporary bundle-relative script paths.

QMD's embedding tokenizer can underestimate the ranking model's input length. The hybrid worker measures complete ranking inputs, including query and template. Oversized passages are divided into windows; each candidate keeps its highest window score and original identity. One ranking context bounds GPU memory and prevents teardown while another ranking operation is still running. Errors remain errors; no lexical fallback substitutes for hybrid search.

## Document maintenance

`inventory.py` locates configured files and attachments and retains source signatures and original locators. `formats.py` handles PDF, office documents, HTML, images, and media. `pipeline.py` owns incremental reuse, retry state, work budgets, and the private catalogue. `cli.py` runs each conversion in a resource-bounded worker.

Book formats such as EPUB and MOBI are excluded before cached text can be reused. Images are converted to RGB PNG before OCR, including GIF frames. Media is probed before transcription. Empty extraction and media without audio are recorded as skips with reasons. Converter crashes and malformed documents remain failures. Extractor versions invalidate old failure backoffs without reprocessing every successful record.

Original files, account configuration, source samples, model files, and generated indexes live outside the repository. The extractor and projection store retain original references for subsequent reads.

## Verification

Run `bun run check`, `bun test`, `bun run demo`, and `bun run test:python` in an environment with the locked extraction dependencies. Tests use invented records. Live source checks are a separate installation audit and their receipts stay private. The GitHub workflow runs tests on Linux and macOS.
