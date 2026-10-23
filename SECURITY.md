# Security and privacy

## Intended use

Source Search connects a single local user to an agent client over stdio and runs with that user's permissions. Remote or multi-user hosting requires an authentication and isolation layer.

Configure the sources you want to share with the connected agent. Configuration also selects local paths and executables. Disabling a source takes effect on the next request; requests already running may finish, and previously returned text stays with the client.

Original records are read-only. Maintenance writes disposable local caches and can download mail attachments or materialize configured iCloud files. Retrieved text, including messages and attachments, is sent to the requesting agent. Review the client's model-provider and retention settings.

Caches, indexes, attachment copies, previews and maintenance logs contain plaintext source data. Store them outside the repository with private permissions. To delete the default managed cache, stop maintenance, preview the target with `purge-cache`, then add `--apply`. Cleanup checks directory ownership and rejects links or locations containing configured originals and models. Custom locations, backups and provider stores need separate cleanup; ordinary deletion leaves storage-level recovery outside the command's scope.

Parsers enforce format and resource limits and run with the user's filesystem access. See [document extraction](docs/maintenance.md#document-extraction) for the limits. Agent clients should treat instructions found in records, links and filenames as quoted content.

## Reporting a vulnerability

Use the repository's private vulnerability-reporting feature. Include a reproduction with sample data, the affected version, expected behavior and actual behavior. Remove personal records, credentials and account details from reports and logs. If private reporting is unavailable, ask the maintainer for a private contact channel.
