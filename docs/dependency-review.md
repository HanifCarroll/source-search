# Dependency review

Reviewed 2026-10-23 against the current source tree. This is a review and migration proposal; the candidate packages have not been added to production dependencies.

The subsequent [comparison with alternatives](dependency-comparison.md) changes the ZIP recommendation to `@zip.js/zip.js`, makes calendar adoption conditional on explicit timezone data, and adds HTML table-formatting requirements. The table below reflects those conclusions; the detailed ZIP section preserves the original `yauzl` evaluation.

The strongest opportunities are standards parsers: HTML, MIME email, iCalendar, and YAML frontmatter. Several small handwritten parsers already produce incorrect results on valid invented inputs. Source-specific record interpretation, original-reference validation, and search orchestration should remain application code.

## Recommended changes

| Priority | Current implementation | Recommendation | Evidence and scope |
| --- | --- | --- | --- |
| First | `stripHtml` in `src/vendor/takeout/parsers.ts`, also used outside Takeout | Adopt `html-to-text` | Named entities remain encoded, a `>` inside an attribute leaks markup into text, and an out-of-range numeric entity throws. A candidate probe handled all three. |
| First | MIME headers, transfer decoding and address splitting in the same file | Adopt streaming `MailParser` from `mailparser` | An ISO-8859-1 email loses its accented character; a quoted sender name containing a comma becomes two participants. The candidate decoded both correctly. |
| Small independent fix | Frontmatter splitting in `src/sources/local/notes.ts` | Use the existing `Bun.YAML.parse` API | A quoted value containing `---` is truncated by the delimiter split. Bun's installed parser preserved it. No additional package is needed. |
| Next | iCalendar parsing in `src/vendor/takeout/parsers.ts` | Prefer `ical.js` with explicit timezone data | Handles embedded zones; bare IANA IDs require registered definitions. Preserve floating/all-day values. |
| Qualified migration | `src/vendor/takeout/zip.ts` | Prefer `@zip.js/zip.js`, retain the application archive contract | File-backed Bun streaming, CRC checking and strict archive options passed the comparison fixtures. |
| Conditional | `parseCsv` in `src/vendor/takeout/parsers.ts` | Consider `csv-parse` for standard CSV; retain explicit export-dialect handling | Our LinkedIn path accepts mixed backslash and doubled-quote escaping. Neither tested candidate configuration accepted that fixture. A direct replacement would regress support. |

### HTML: make one shared conversion boundary

The current regular-expression conversion is used by mail, PIM and archive readers. Generic HTML conversion should live in a low-level text-format module, rather than making those adapters depend on a Takeout parser. A small wrapper around `html-to-text` should own whitespace, link formatting and input limits. Source adapters should still choose the fields and attribution included in a record.

Invented comparisons with `html-to-text` 10.0.1:

| Input | Current output | Candidate output |
| --- | --- | --- |
| `<p>caf&eacute; &mdash; pi&ntilde;ata</p>` | `caf&eacute; &mdash; pi&ntilde;ata` | `café — piñata` |
| `<p title="a > b">Visible text</p>` | `b">Visible text` | `Visible text` |
| `<p>text &#x110000;</p>` | `RangeError` | `text �` |

The package includes text formatting as well as HTML parsing. Bun's built-in HTML rewriting API is another possible parsing primitive, but would still leave readable text layout in our code. The candidate was exercised on Bun 1.3.14; its declared Node minimum is 20.19.0 and its license is MIT. See the [official package documentation](https://github.com/html-to-text/node-html-to-text/blob/master/packages/html-to-text/README.md).

### MIME: replace decoding, preserve export identity

The synthetic email used `Subject: =?ISO-8859-1?Q?caf=E9?=`, a quoted-printable body `caf=E9`, and sender `"Doe, Jane" <jane@example.test>`. Today the subject and body become `caf�`, and the sender splits into two participants. `mailparser` 3.12.4 returned `café` and one address with the correct display name.

Use the streaming `MailParser` interface in production. The probe used `simpleParser` for a tiny fixture, but that convenience API buffers the message and attachments. Drain and release attachment streams without extracting their contents. Keep MBOX message boundaries, selected-entry access, duplicate Message-ID handling, stable source IDs and archive hashes in the source adapter. MIME parsing will introduce an asynchronous boundary into `parseTakeoutEntry`; propagate it explicitly to its callers. The package is MIT and declares Node 20 or newer. See [MailParser's API and streaming requirements](https://nodemailer.com/extras/mailparser).

### YAML: use the runtime we already require

For an invented note containing `source_audio: "fixture://recording---part"`, the current reader returns `fixture://recording`. `Bun.YAML.parse` returns the complete value. Parse only a frontmatter block delimited by lines at the start of the note, validate the fields the adapter uses, and preserve the Markdown body and its offsets. Do not split on every occurrence of `---`.

The API was verified in the project's minimum Bun version, 1.3.14; see [Bun's YAML API](https://bun.sh/docs/runtime/yaml). If a future runtime change requires an independent implementation or parser controls, [`yaml`](https://eemeli.org/yaml/) is a candidate; adding it alongside the available Bun parser has no demonstrated benefit here.

### iCalendar: interpret supplied time zones

An invented calendar defined `TZID:Fixture/Offset` with `TZOFFSETFROM:+0230` and `TZOFFSETTO:+0230`. Its event started at `20260101T100000`. The current parser retained the source value but could not produce `occurredAt`; `ical.js` 2.2.1 produced `2026-01-01T07:30:00.000Z` after registering the embedded zone.

Use a calendar-scoped timezone lookup so separate exports cannot overwrite each other's identically named zones. Retain raw values for floating and all-day events; they are not automatically instants. Recurrence expansion needs an explicit bounded range and is not required merely to replace parsing. This affects exported calendars, not native EventKit reads. The package has no runtime dependencies and uses MPL-2.0; retain its own license and review distribution notices when adopting it. See [ICAL.js APIs](https://kewisch.github.io/ical.js/api/) and its [license](https://github.com/kewisch/ical.js/blob/main/LICENSE).

### ZIP: replace mechanics, keep the archive contract

The current implementation handles central directories, ZIP64, decompression, CRC32, names and limits itself. `yauzl` 3.4.0 supplies lazy entry iteration and decompressed size validation. A small stored-entry fixture read successfully on Bun 1.3.14. In a second fixture, one payload byte was changed without updating CRC32. The existing reader rejected it; unwrapped `yauzl` returned the damaged text. This matches its documented lack of CRC32 checking.

Keep these responsibilities in our wrapper: checksum verification, entry/total/count/compression-ratio limits, path and symlink policy, duplicate-name behavior, archive and entry identity, and source-change checks. Preserve the selected-entry read interface. A migration should stream archive hashing and entries rather than replace the current parser with `fromBuffer` and retain the same whole-file memory cost. The probe does not qualify large archives, ZIP64 or malformed archive handling; those need contract tests before replacement. Bun 1.3.14's documented `Archive` API handles tar/gzip, not this ZIP contract. See [yauzl's API and limitations](https://github.com/thejoshwolfe/yauzl).

### CSV: avoid losing supported export quirks

`csv-parse` 7.0.3 is an MIT parser with stream and synchronous APIs and no runtime dependencies. It is a reasonable replacement when standard CSV parsing or streaming large entries becomes necessary. However, the invented field `A \"backslash\" and ""double"" quote` inside an outer quoted field passes the current LinkedIn-aware parser and fails both the default candidate configuration and its backslash-escape configuration.

Do not quietly enable relaxed parsing and drop malformed records. First define fixtures for each selected export dialect, including multiline fields, BOMs, empty/trailing cells and unquoted search-log fields. Keep a small dialect adapter if needed. The current CSV implementation is small enough that this has lower priority than demonstrated MIME/HTML failures. See the [CSV Parse documentation](https://csv.js.org/parse/).

## Code that should stay, or be simplified without a new dependency

| Area reviewed | Decision |
| --- | --- |
| CLI and MCP validation | Keep the official MCP SDK and Zod. Another schema or CLI framework would duplicate existing contracts. |
| SQLite access and snapshots | Keep Bun SQLite and explicit SQL. An ORM does not remove the need to understand external application schemas, WAL consistency, source fingerprints or read-only snapshots. |
| ChatGPT, Takeout, LinkedIn and Twitter record interpretation | Retain export-specific mapping, conversation branches, roles, timestamps, attachments and identities. Standards libraries can replace parsing underneath these decisions. |
| CASS integration | Retain its typed protocol, result validation and source-specific recovery. CASS already supplies the search engine; another agent-history framework is unnecessary. |
| Mail, CASS and QMD subprocess runners | Consolidate repeated spawning, byte limits, timeouts and cleanup into a small Bun-native process utility if doing further boundary work. Keep argument construction and provider errors in adapters. Execa is capable, but adding it now would not remove those policies. |
| QMD ranking and embeddings | Keep QMD as the engine. The custom layer handles bounded reranking windows, pinned-version integration and atomic embedding batches. Track upstream fixes before removing those patches; a new search framework does not solve them. |
| Messages attributed-body decoding | Keep the small supported decoder and explicit unsupported status for now. A broader typedstream parser would add runtime/interop cost; qualify it against actual unsupported formats before adopting it. |
| Domain records, matching, sections, cursors and attribution | Keep the product-specific logic. General utilities or orchestration frameworks would obscure these contracts. A full Markdown parser is not needed for the current section/offset operations. |
| Source file selection and private storage | Keep the small filesystem policies and Bun/Node APIs. `fs-extra`, glob libraries and queue frameworks are not justified by a demonstrated gap. |
| Refresh process | Keep Python's filesystem/process APIs and launchd integration. A watcher library should follow a measured polling problem, not replace working scheduling by default. |
| Optional document extraction | Already uses pypdfium2, Pillow, python-docx and BeautifulSoup. Keep those libraries and format-specific controls; no case for a universal document/AI ingestion framework. Extraction remains opt-in and book exclusion remains separate policy. |
| Native contacts, calendar and reminders | Already uses Apple's Contacts, EventKit and Foundation frameworks. Keep the small Swift bridge and its permissions identity. |

The review covered the application/domain/platform layers, all source families, the vendor parsers and CASS adapter, QMD/library retrieval, Python extraction and refresh, the Swift bridge, runtime loading and existing tests. Candidate packages were installed only in an isolated probe directory. No account data was used in the comparisons.

## Suggested implementation order and acceptance

1. Fix frontmatter using Bun YAML; migrate shared HTML conversion with exact output fixtures.
2. Replace MIME decoding behind the existing archive record interface.
3. Replace iCalendar parsing with scoped timezone handling.
4. Migrate ZIP internals only after the existing archive contract tests pass against the wrapper; decide CSV separately by export dialect.

Every text-changing migration must update projection versions so unchanged originals are reindexed. Verify search, direct reads, continuation, original references and stale-reference rejection together. Preserve disabled-source behavior and extraction settings. Keep fixture comparisons in tests and run the Bun/type/Python suites plus the demo. Do not infer production readiness from these small compatibility probes alone.

The separate coverage repair accompanying this review adds WhatsApp photo/video/GIF captions to reads and projections, versions the database projection, and scopes library embedding warnings to selected sources. It does not implement the proposed parser migrations.
