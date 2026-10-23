# Release verification

Examples and fixtures use sample data. Keep live verification records outside the repository.

Run TypeScript checking, Bun regression tests, the Python suite, the synthetic demo, a dependency audit and a redacted Git history secret scan before release. CI repeats these checks where supported.

The release safety suite checks disabled-source catalogue behavior, group expansion, guessed references, old library references, cached snippets, account routing, private directories, and revocation after configuration changes. Existing tests cover pagination, source preservation, archive validation, path traversal, stale versions, output bounds and read-only command arguments.

Also check the installed provider versions, native helper signing and permissions, account access, and performance with large archives. Parser fuzzing is a separate validation step. Review release files and Git history alongside the scanner results.
