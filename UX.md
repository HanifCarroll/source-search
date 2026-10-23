# Retrieval behavior

Source groups expand to individual queries. Disabled sources return `SOURCE_DISABLED`; they are never silently re-enabled by group expansion, a direct record reference, or a library hit.

Search results distinguish content matches, title/name matches, provider previews and metadata. A filename is not evidence about a file's contents. Open the original before synthesizing an answer.

`focus` opens the matching passage. `nextCursor` continues bounded text or search pages. Changed source versions fail explicitly. A failed or partial source is not a successful empty result.

Native filters vary by adapter. Provider-native search does not silently substitute a semantic query. Hybrid/library discovery rejects unsupported exact filters. Scores are not globally comparable across providers.

Previews are explicit private text files, not source edits. Browser history and download records are metadata; resource links require their own authorized reader.
