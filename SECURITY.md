# Security and privacy

## Intended use

Source Search is a stdio service for a trusted local user and agent client. It runs with that user's permissions. It is not a sandbox, a remote service, or a multi-user authorization boundary. Do not expose it through an HTTP bridge without a separate security design.

All sources default to disabled. Enable only the sources you intend to share with the connected agent. Configuration and the checkout are trusted local inputs. Changing them can grant access or change executable paths. Revocation applies to subsequent requests; it cannot retract text already returned or cancel an in-flight request.

Original records are read-only. Maintenance writes disposable local caches and can download mail attachments or materialize configured iCloud files. Retrieved text, including messages and attachments, is sent to the requesting agent. Review the client's model-provider and retention settings.

Plaintext caches, model indexes, attachment copies, previews and maintenance logs may contain sensitive information. Store them outside the repository with private permissions. Disabling a source is not deletion. Stop maintenance, inspect the cleanup target, then use `purge-cache --apply` for the default managed cache. Custom locations, OS backups and external provider stores require separate cleanup.

Parsers enforce format and work limits but have not been exhaustively fuzzed. Use only exports and documents you are authorized to process. Retrieved instructions, web links and filenames are untrusted data; the server does not authorize actions described in them.

## Reporting a vulnerability

Use the repository's private vulnerability-reporting feature when enabled. Do not post personal records, credentials, account configuration or unredacted logs in public issues. Include a synthetic reproduction, the affected version, expected behavior and actual behavior. If private reporting is unavailable, ask the maintainer for a private channel without disclosing the vulnerability or source data publicly.
