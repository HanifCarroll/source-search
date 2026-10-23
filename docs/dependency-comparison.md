# Comparing parser libraries for Source Search

2026-10-23. This follow-up tests alternatives to the initial [dependency review](dependency-review.md). All candidate installations and experiments were isolated from the application. The comparison itself did not change production dependencies. The implementation described below followed it.

## Decisions

| Area | Candidates considered | Best fit for the current requirements |
| --- | --- | --- |
| HTML to searchable text | html-to-text 10.0.1, Cheerio 1.2.0, Turndown 7.2.4; parse5 and Bun HTMLRewriter as lower-level alternatives | **html-to-text**, with explicit table/whitespace settings. |
| MIME email | MailParser 3.12.4, PostalMime 4.1.4 | **Streaming MailParser**. Both decoded the fixture correctly; MailParser can drain attachment bytes without retaining decoded attachments. |
| Calendar exports | ICAL.js 2.2.1, node-ical 0.27.3 | **ICAL.js with timezone definitions**, provisionally. Neither library is a correct unconfigured drop-in for all required date cases. |
| ZIP archives | zip.js 2.24.0, yauzl 3.4.0, fflate 0.8.3, JSZip 3.10.2 | **zip.js**, replacing the earlier preference for yauzl. It covers more of our existing archive checks and works with file-backed Bun streams. |
| Frontmatter | Bun 1.3.14 YAML, yaml 2.9.1, gray-matter 4.0.3 | **Bun YAML**, with a small, tested frontmatter boundary reader. |
| CSV | csv-parse 7.0.3, Papa Parse 5.7.0, current export-aware parser | **Keep the current parser for now**. Use csv-parse if standard CSV streaming becomes necessary; retain LinkedIn dialect handling. |

“Best fit” here weighs correctness on our fixtures, removal of custom format machinery, bounded processing, Bun compatibility, dependency cost and the existing source-reference contract. It is not a claim that one library is universally best. These are focused compatibility tests, not a large-file performance benchmark or complete migration qualification.

## What the comparisons demonstrated

### HTML

All three tested packages correctly decoded named entities, handled a `>` inside a quoted attribute, and replaced an invalid numeric character reference. Their text output differed materially:

- Cheerio's `.text()` concatenated neighboring paragraphs and list entries unless given our own formatting traversal. That would leave us maintaining text-conversion logic. Cheerio uses parse5 for standard HTML parsing; adopting either is useful for DOM queries, which are not the requirement here. See [Cheerio's parser choices](https://cheerio.js.org/docs/advanced/configuring-cheerio/).
- Turndown produced Markdown, and its default output retained the synthetic script/style text. It could be configured, but requires policy changes for a different target format. See [Turndown's documented purpose and rules](https://github.com/mixmark-io/turndown).
- html-to-text supplied useful paragraph, line-break and list boundaries and excluded script/style text. Its **default table formatter still joined two cells into `LeftRight`**. Setting `table` to `dataTable` produced `Left   Right`. The migration must distinguish data tables from email layout tables, set limits explicitly, and test multiline cells. See the [formatter documentation](https://github.com/html-to-text/node-html-to-text/blob/master/packages/html-to-text/README.md).

This supports the original choice, but not use of its defaults without tests. MailParser 3.12.4 already depends on html-to-text 10.0.1, so these two proposed choices can share the same version.

### MIME

Both MailParser and PostalMime correctly handled the same ISO-8859-1 subject/body and quoted sender name. A synthetic multipart message contained a 1 MiB attachment. Streaming MailParser delivered attachment chunks that the probe drained; PostalMime returned the decoded 1 MiB attachment in its result.

PostalMime is an attractive zero-runtime-dependency alternative, particularly for browser/serverless programs. Its documented stream input is consumed before parsing, however. Source Search runs locally on Bun and processes attachment-bearing exports, so MailParser's stream interface is the better fit despite its larger dependency graph. Use only its parsing API; no sending functionality is needed. This change alone does not make the existing whole-archive/MBOX reader stream: that is a separate integration boundary. See [PostalMime's input and output model](https://github.com/postalsys/postal-mime) and [MailParser's streaming API](https://nodemailer.com/extras/mailparser).

### Calendars

Three fixtures exposed a limitation in each candidate. The process timezone in these tests was America/Argentina/Buenos_Aires.

| Fixture | Required interpretation | node-ical | ICAL.js without extra zone data |
| --- | --- | --- | --- |
| Embedded custom `Fixture/Offset`, +02:30, 10:00 | 07:30 UTC | 13:00 UTC; used the process timezone | 07:30 UTC after registering the embedded definition |
| `America/New_York`, January 1 at 10:00, no embedded definition | 15:00 UTC | Correct | Fell back to floating; converting it produced 13:00 UTC |
| Floating January 1 at 10:00 | Preserve a wall-clock value, not an invented instant | Conversion produced 13:00 UTC | Conversion produced 13:00 UTC; object retains its floating-zone marker |

ICAL.js explicitly documents that it ships without registered IANA timezone data. It supports embedded `VTIMEZONE` definitions and exposes floating/date-only semantics, making it the stronger parsing foundation here, **provided adoption includes a maintained timezone-data strategy**. Load definitions locally, keep custom zones scoped to their calendar, and never silently convert unresolved/floating values through the machine timezone. Current tests do not qualify the distribution/update mechanism for that timezone data.

node-ical is a credible alternative: it includes IANA/Windows zone handling and recurrence features, but failed the arbitrary embedded-zone fixture. Its current Node minimum is 22; its installed runtime dependencies include recurrence and Temporal implementations. Source Search needs faithful export interpretation, not recurrence expansion by default. See [ICAL.js timezone requirements](https://github.com/kewisch/ical.js#timezones) and [node-ical's features](https://github.com/jens-maus/node-ical).

### ZIP

The earlier recommendation underestimated zip.js. The comparison used the same valid stored-entry fixture and a copy with a changed payload byte but unchanged CRC32:

| Candidate | Valid fixture | Damaged fixture |
| --- | --- | --- |
| Current reader | Read | Rejected |
| yauzl, unwrapped | Read | Returned damaged text |
| fflate `unzipSync` | Read | Returned damaged text |
| JSZip with `checkCRC32: true` | Read | Rejected |
| zip.js with CRC checking enabled | Read | Rejected |

Additional zip.js tests used `BlobReader(Bun.file(path))` and a byte-limited `WritableStream`. Deflated and forced-ZIP64 fixtures read correctly; strict options rejected duplicate filenames and `../` traversal names. Use `checkCrc32: true` (the newer name for `checkSignature`), strict ambiguity checks and overlap checks explicitly. Keep our byte/count/ratio limits, symlink policy, hashing, source-change checks and stable entry references in the wrapper. Pin and test these options rather than assume defaults enforce the contract. See [zip.js options](https://gildas-lormeau.github.io/zip.js/api/interfaces/ZipReaderOptions.html).

zip.js 2.24.0 declares Bun support, has no runtime dependencies, and uses BSD-3-Clause. It is the preferred migration candidate. The small ZIP64 test does not establish multi-gigabyte behavior; a full adapter migration still needs existing archive contract tests and a representative large synthetic archive.

yauzl remains reasonable for a Node file-descriptor API, but would leave more checking in our wrapper. fflate's small, general compression API does not remove the missing integrity work. JSZip supports CRC checks, but its duplicate-name replacement and path normalization require extra care with original-entry identity, and it documents memory/ZIP64 limitations. See [JSZip load behavior](https://stuk.github.io/jszip/documentation/api_jszip/load_async.html), [JSZip limitations](https://stuk.github.io/jszip/documentation/limitations.html), [yauzl](https://github.com/thejoshwolfe/yauzl), and [fflate](https://github.com/101arrowz/fflate).

### Frontmatter and CSV

Bun YAML, yaml and gray-matter all preserved `source_audio: "fixture://recording---part"` and an array of tags. yaml offers document editing, comments and parser controls that this read-only adapter does not need. gray-matter supplies frontmatter boundaries and additional formats, but adds four direct dependencies; it would be appropriate if multi-format frontmatter became a requirement. For the current two delimiters and a few validated fields, Bun YAML is sufficient. See [yaml](https://eemeli.org/yaml/) and [gray-matter](https://github.com/jonschlinkert/gray-matter).

csv-parse and Papa Parse both handled standard quoted, multiline CSV. Neither cleanly accepted the mixed backslash/doubled-quote LinkedIn fixture: csv-parse threw; Papa returned rows plus two `InvalidQuotes` errors. Ignoring those errors is not a successful replacement. Papa's browser/file UI facilities add no benefit to this local import path. Keep the current dialect adapter; csv-parse remains a reasonable standard-format backend if streaming justifies it. See [Papa Parse's result/error contract](https://www.papaparse.com/docs) and [CSV Parse](https://csv.js.org/parse/).

## Next implementation boundaries

1. Bun YAML and configured html-to-text can be adopted independently with output fixtures.
2. Streaming MailParser needs an asynchronous MIME boundary and explicit attachment draining.
3. ICAL.js needs timezone definitions, unresolved-zone behavior and all-day/floating tests before adoption.
4. zip.js needs an adapter preserving original identity and limits; the full archive suite should run against it before removing the current reader.
5. Leave CSV unchanged unless a concrete streaming or correctness requirement outweighs the dialect migration cost.

The installed candidate dependency set reported no known vulnerabilities in `bun audit` at review time. Licenses checked in the installed metadata: MIT (HTML/MIME/CSV candidates), MIT-0 (PostalMime), MPL-2.0 (ICAL.js), Apache-2.0 (node-ical), BSD-3-Clause (zip.js), ISC (yaml), and an MIT-or-GPL choice for JSZip. Retain dependency notices when distributing them. No claim here replaces an integration test or ongoing dependency updates.

## Implemented integration

The application now uses html-to-text, streaming MailParser, ICAL.js, zip.js and Bun YAML. The export-aware CSV parser remains. Temporal's polyfill supplies IANA-zone conversion from the runtime's timezone data; ICAL resolves embedded VTIMEZONE within each calendar. Floating and all-day values keep their original meaning. Recurrences are retained without expansion.

WhatsApp poll receipt envelopes use a small protobuf.js schema for the question and options. ICAL.js also parses shared vCards. The adapter selects contact text fields, separates concatenated cards, and normalizes WhatsApp's unindented text continuations before parsing; binary photos and overloaded media fields are excluded.

ZIP archives use file-backed BlobReader access, streamed archive/compressed hashes, strict local-header and overlap checks, CRC verification, and bounded output. Original entry identities remain path-based. MBOX entry bytes are still bounded and buffered; MailParser drains decoded attachments without retaining them. These changes do not implement a streaming MBOX archive iterator.

Parser versions invalidate archive and WhatsApp projections. Saved mail responses are reformatted locally without fetching every message again. Regression tests cover checksums, ZIP64, unsafe paths, size limits, source changes, MIME charsets and attachments, calendar DST/custom zones, contact variants, poll decoding, and cache upgrades. All test records are invented.

The file-backed ZIP adapter was also checked against a generated 128 MiB ZIP64 archive with four independently hashed payloads. This exposed a Bun 1.3.14 sliced-Blob stream stall; fingerprints now use bounded Node file streams. A 64 MiB, two-entry subprocess regression test catches the stall and verifies read completion.

Zod is pinned to 4.6.6 for both the application and MCP SDK, resolving [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). Runtime reloads fingerprint the dependency manifest and lockfile as well as source files. Existing MCP transports require one reconnect after dependency updates.
