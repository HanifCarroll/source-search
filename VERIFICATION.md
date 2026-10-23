# Release verification

All committed examples and fixtures use invented data. Live provider receipts, archive counts, personal queries and private source samples are intentionally excluded.

Run TypeScript checking, Bun regression tests, the Python suite, the synthetic demo, a dependency audit and a redacted Git history secret scan before release. CI repeats these checks where supported.

The release safety suite checks disabled-source catalogue behavior, group expansion, guessed references, old library references, cached snippets, account routing, private directories, and revocation after configuration changes. Existing tests cover pagination, source preservation, archive validation, path traversal, stale versions, output bounds and read-only command arguments.

Synthetic tests do not replace live compatibility verification of optional provider tools. Native signing/OS authorization, real account access, large archive performance and adversarial parser fuzzing require separate validation. A clean scanner result is not a guarantee that no sensitive material exists; manually inspect the release files and history too.
