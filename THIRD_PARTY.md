# Third-party components

Source Search code is distributed under MIT. Dependencies keep their own licenses. The lockfiles identify exact versions; installing dependencies does not relicense them under the project's MIT license.

| Component | License / source |
| --- | --- |
| MCP TypeScript SDK | MIT; https://github.com/modelcontextprotocol/typescript-sdk |
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

This source repository does not redistribute dependency wheels, provider binaries or models. If you distribute a standalone binary or image containing these dependencies, retain their license files and notices, including PDFium's bundled component licenses. Review licenses for separately installed QMD, CASS, mail tools, Tesseract, transcription tools and models for the specific versions/builds you distribute.

PyMuPDF is not a dependency of this release. Existing personal installations are not modified by this repository.
