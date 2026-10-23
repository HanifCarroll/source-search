# Third-party components

Source Search code is distributed under MIT. Dependencies keep their own licenses. The lockfiles identify exact versions.

| Component | License / source |
| --- | --- |
| MCP TypeScript SDK | MIT; https://github.com/modelcontextprotocol/typescript-sdk |
| html-to-text | MIT; https://github.com/html-to-text/node-html-to-text |
| MailParser | MIT; https://github.com/nodemailer/mailparser |
| ICAL.js | MPL-2.0; https://github.com/kewisch/ical.js (unmodified dependency; package includes its source and license) |
| Temporal polyfill | ISC; https://github.com/js-temporal/temporal-polyfill |
| zip.js | BSD-3-Clause; https://github.com/gildas-lormeau/zip.js |
| protobuf.js | BSD-3-Clause; https://github.com/protobufjs/protobuf.js |
| Parser types (development) | MIT; https://github.com/DefinitelyTyped/DefinitelyTyped |
| Zod | MIT; https://github.com/colinhacks/zod |
| TypeScript (development) | Apache-2.0; https://github.com/microsoft/TypeScript |
| Bun types (development) | MIT; https://github.com/oven-sh/bun |
| pypdfium2 | Apache-2.0 OR BSD-3-Clause; https://github.com/pypdfium2-team/pypdfium2 |
| PDFium (installed with the pypdfium2 wheel) | BSD-style and component notices shipped in the wheel; https://pdfium.googlesource.com/pdfium/ |
| Pillow | MIT-CMU; https://github.com/python-pillow/Pillow |
| python-docx | MIT; https://github.com/python-openxml/python-docx |
| Beautiful Soup | MIT; https://www.crummy.com/software/BeautifulSoup/ |
| lxml | BSD-3-Clause plus bundled library notices; https://lxml.de/ |
| Soup Sieve | MIT; https://github.com/facelessuser/soupsieve |
| typing-extensions | PSF-2.0; https://github.com/python/typing_extensions |

If you distribute a standalone binary or image containing these dependencies, retain their license files and notices, including PDFium's bundled component licenses. Review licenses for separately installed QMD, CASS, mail tools, Tesseract, transcription tools and models for the specific versions/builds you distribute.

## Code provenance

The initial Messages snapshot/reader code, ChatGPT export parser, Google Takeout parser/ZIP reader, CASS provider and macOS PIM helper were extracted from LifeOS revision `48a799286ee2234e109ddaf41bf9788f14e0c2cf`, then adapted for targeted retrieval. Runtime imports from the original application were removed. These components are included under the project’s MIT license.

The Messages typedstream reader uses format definitions inspected in [python-typedstream](https://github.com/dgelessus/python-typedstream/blob/main/src/typedstream/stream.py); that implementation was not copied. Tests encode invented records using the supported format subset.
