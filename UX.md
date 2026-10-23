# Retrieval behavior

Source groups expand to individual queries. Disabled sources return `SOURCE_DISABLED` for group queries, direct references and library hits.

Search results distinguish content matches, title/name matches, provider previews and metadata. Open the original to answer questions about its contents.

`focus` opens the matching passage. `nextCursor` continues bounded text or search pages. Changed source versions return an error. Results report failures and partial coverage separately from empty matches.

Native filters vary by adapter. Select semantic search with the `mode` option. Hybrid/library discovery rejects unsupported exact filters. Scores are not globally comparable across providers.

Previews are private text files created on request. Browser history and download records contain metadata; open linked resources with the appropriate reader.
