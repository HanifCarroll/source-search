# Source setup

Follow the [README setup steps](../README.md#setup) first, then use only the sections for your selected sources. Source definitions in this guide go under `sources`; add their IDs to `enabledSources` too.

## Configuration and credentials

A source ID names one account, folder or selection. Use stable lowercase IDs with letters, digits and hyphens; saved references depend on them. `adapter` selects the integration and optional `label` supplies a display name. Except for the aggregate `library` and `documents` views, integrations can have multiple named instances, up to 100 sources in total.

Use absolute paths in JSON, with `~` expanded. Keep configuration and credentials outside the checkout. Store private config/token files with mode `0600` in a `0700` directory. Credentials accept one of `{"file":"/absolute/path"}`, `{"env":"VARIABLE_NAME"}` or `{"command":["/absolute/token-tool","argument"]}`. Commands run without a shell and must print one credential. Set environment credentials in the MCP client's environment as well as your terminal.

Executables are discovered on `PATH`; set explicit paths such as `gmailBinary`, `bunBinary` or a source's `binary` when a background process has a different `PATH`. Full settings are defined in [source-settings.ts](../src/platform/source-settings.ts), [connected-settings.ts](../src/platform/connected-settings.ts) and [config.ts](../src/platform/config.ts).

## Markdown folders

```json
{
  "notes": {"adapter": "markdown", "root": "/absolute/path/to/notes"},
  "journal": {
    "adapter": "markdown", "root": "/absolute/path/to/journal",
    "pattern": "**/????-??-??.md", "dateFromFilename": true,
    "dateFields": [], "content": "journal"
  }
}
```

Markdown sources default to ordinary notes, `**/*.md`, the `date` frontmatter field, and exclusions for `.git` and `node_modules`. Set `exclude` to your own glob list, `dateFromFilename` to read a leading `YYYY-MM-DD`, and `content` to `journal` or `transcript` when appropriate. Transcripts can set `reviewed: true`; `journal: true` includes a transcribed journal in `all-journals`. Attribution is unspecified unless you set `author`.

Date-only and offset-free note dates use the source's `timeZone`, then the global `timeZone`, then UTC. Dates with an explicit offset retain their instant.

For ranked folder search, use a [`vault` source](maintenance.md#managed-search-indexes).

## Calendar and contact files

```json
{
  "schedule": {"adapter": "ical", "paths": ["/exports/calendar.ics"], "timeZone": "Europe/Berlin"},
  "people": {"adapter": "vcard", "paths": ["/exports/contacts.vcf"]}
}
```

Use iCalendar or vCard exports from any compatible application. Calendar searches require `from` and `to` timestamps; floating calendar times use the source timezone, then the global timezone. Contact cards without UIDs use content-based identity; edits to those cards require a new reference. Both sources read their files directly.

## Browser profiles

```json
{
  "work-history": {
    "adapter": "browser-history",
    "profiles": [{"id": "work", "path": "/absolute/path/to/browser/Profile 1"}]
  }
}
```

For Chrome, Edge, Brave and other Chromium browsers, use `browser-history`, `browser-bookmarks` or `browser-downloads`. Downloads are metadata only. Select actual profile folders, rather than the browser's parent data folder.

Keep browser profile IDs stable when reordering or adding profiles. Existing `chrome-*` adapter names remain supported. To retain old numeric browser references when migrating a flat `chromeProfiles` list, set `legacyProfileIds` to its original order, for example `["work", "personal"]`, and keep that list unchanged. For Firefox, use `firefox-history` or `firefox-bookmarks` with profile folders containing `places.sqlite`. For Safari, use `safari-history` with folders containing `History.db`, or `safari-bookmarks` with the folder containing `Bookmarks.plist` (normally `~/Library/Safari`, expanded to an absolute path). These use the same `profiles` configuration. Safari bookmarks support binary and XML property lists; local browser access uses the existing filesystem permissions. Safari bookmarks have no creation date. History readers use live SQLite snapshots and keyset continuation, so they need no separate index. They search retained titles and URLs; they do not fetch page contents.

## Local messages and calls

```json
{
  "sms": {"adapter": "messages"},
  "whatsapp": {"adapter": "whatsapp", "database": "/absolute/path/to/ChatStorage.sqlite"},
  "calls": {"adapter": "muesli", "database": "/absolute/path/to/muesli.db"}
}
```

These readers use macOS application databases. Messages defaults to `~/Library/Messages/chat.db`; set `database` to override it. WhatsApp commonly stores `ChatStorage.sqlite` under `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/`, and Muesli uses `~/Library/Application Support/Muesli/muesli.db`. Resolve the current user's paths and check that the files exist before configuring them.

Use `doctor` to check access. If macOS blocks a database read, the user needs to grant the launching application the requested filesystem access in System Settings. Search covers records stored on this Mac, including supported WhatsApp captions, polls and contact cards. It does not fetch missing message history or media from the account. No separate sync command is needed for direct search.

## Account exports

```json
{
  "past-chats": {"adapter": "chatgpt-archive", "paths": ["/exports/chatgpt.zip"]},
  "google-export": {"adapter": "takeout-archive", "paths": ["/exports/takeout.zip"]},
  "linkedin-export": {"adapter": "linkedin-archive", "paths": ["/exports/linkedin.zip"]},
  "social-export": {"adapter": "twitter-archive", "paths": ["/exports/twitter.zip"]}
}
```

Select downloaded ZIP exports; ChatGPT also accepts an extracted export directory containing its conversation JSON files. Multiple export parts can be listed in `paths`. Enable `maintenanceEnabled` and run `bun run start rebuild` after adding or replacing exports. Then use `sources` to inspect available record types, dates and coverage before searching. The `twitter-archive` adapter reads X exports.

## Agent history

Install [CASS](https://github.com/Dicklesworthstone/coding_agent_session_search) and build its index for the sessions you want to search. The adapter was developed against CASS 0.10.0. Configure its existing data directory and executable:

```json
{
  "coding-history": {
    "adapter": "agent-history",
    "data": "/absolute/path/to/cass-data",
    "binary": "/absolute/path/to/cass"
  }
}
```

CASS owns ingestion and incremental indexing. Source Search's `sources` command reports its readiness and recovery guidance; `rebuild` only handles account exports. Keep a working CASS index and its existing refresh process when adding this connector.

## Task apps

Things can [export its SQLite database](https://culturedcode.com/things/support/articles/2982272/). Select `main.sqlite` from that export. Tasks, projects, areas, headings, tags and checklists become searchable after `sync-tasks`; the older JSONL/project export uses `connector.root`. The reader does not require Things to be installed. Existing `things-archive` configurations continue using `rebuild` and keep their references.

Use one source per account or selected set of task files. For example:

```json
{
  "maintenanceEnabled": true,
  "enabledSources": ["work-tasks", "home-tasks"],
  "sources": {
    "work-tasks": {"adapter": "tasks", "connector": {
      "type": "todoist", "account": "work",
      "token": {"file": "/absolute/private/path/todoist-token"}
    }},
    "home-tasks": {"adapter": "tasks", "connector": {
      "type": "ticktick", "account": "home", "projects": ["YOUR_PROJECT_ID"],
      "token": {"file": "/absolute/private/path/ticktick-token"}
    }}
  }
}
```

Put an existing API token in each private file (`0600`). [Todoist's API](https://developer.todoist.com/api/v1/) accepts its personal API token; [TickTick's API](https://developer.ticktick.com/docs/index.html#/openapi) supports personal tokens or OAuth with `tasks:read`. TickTick project IDs come from its project URL or the API's **Get User Project** response. `account` is your stable local identifier for that account; change it when switching accounts. Source Search uses read endpoints and sends no task commands.

Run `bun run start sync-tasks` (or `sync-tasks work-tasks`), then search `all-tasks`. A library refresh also synchronizes enabled task sources. Task keyword search needs neither the library nor models; add the library for semantic/hybrid discovery.

Todoist loads active tasks, descriptions, subtasks, project/section names, dates, labels and comments, then follows its incremental change feed. Completed and deleted tasks leave that active index. TickTick reads the selected project snapshots, including checklists, and compares records before updating projections. Its complete historical archive and comments are not imported. `from`/`to` filter creation timestamps when the provider supplies them; `task.dueFrom`/`task.dueBefore` filter due dates. `sources` reports coverage and the last successful sync; failed passes retain the previous snapshot. Original reads check the provider again and reject changed references.

For another app, use `{"adapter":"tasks","connector":{"type":"json","paths":["/absolute/path/tasks.json"]}}`. The file format is `{"version":1,"tasks":[{"id":"stable-id","title":"Plan the observatory","status":"open"}]}`. Optional fields are `description`, `project: {"id":"p","name":"Observatory"}`, `parentId`, `section`, `labels`, `priority`, `createdAt`, `completedAt`, `due`, `deadline`, `recurrence`, `comments`, and `checklist: [{"title":"Compare lenses","completed":false}]`. Timestamps include an offset; status is `open`, `completed` or `canceled`. IDs must be unique within the source and remain stable across exports. Each source is bounded to 20,000 records and 32 MiB; oversized or incomplete responses fail without pruning the previous snapshot.

### Task queries

Use the existing search tool to list tasks with exact filters. For example, open tasks due from October 26 through November 1, 2026:

```json
{"queries":[{"source":"all-tasks","query":"","task":{"status":"open","dueFrom":"2026-10-26","dueBefore":"2026-11-02"},"sort":"due","limit":25}]}
```

Use dates for the requested week. `dueFrom` includes its date; `dueBefore` excludes its date. Dates are calendar dates as reported by each provider, including the date component of a timestamp; they are not converted to the machine's timezone. Date-only tasks stay on that day. Original reads retain time/zone details where supplied. Things uses **Deadline**, never its **When/start date**. Other apps use their `due` field; a separate Todoist `deadline` remains in the original record.

`task.status` accepts `open`, `completed` or `canceled`. Add `projectId` or `projectName` inside `task` for exact matching; project IDs are scoped to a source, and names are case-sensitive. Names shared by multiple projects match all of them. Calendar lists in Reminders, Microsoft To Do and Google Tasks act as task projects. `task:{}` lists all non-trashed tasks, excluding project/heading records. Combine these filters with text, creation dates or sections. Omit `mode`, or use `lexical`; semantic/hybrid discovery does not accept exact task filters.

Due order puts undated tasks last and uses stable IDs to break ties. Follow `nextCursor` using that result's source ID and the same filters. Changing only `limit` is allowed. An unchanged sync preserves continuation; a changed snapshot requires restarting the query.

`totalMatches` counts matches in that source's selected snapshot, before pagination. `coverage` gives its timestamp, provider limits and any failed latest sync. The count is not a claim about the entire account or missing history: Todoist's snapshot contains active tasks; an old Things export has historical statuses. Tasks without a due date do not match a due-date range. Unsupported date values produce a warning; unclassified legacy task records suppress the total until a successful refresh. These queries work without models or the combined library, including against existing `things-archive` sources.

## Native Apple calendars and contacts

Reuse an existing native helper when available. Building a new helper requires macOS, Xcode Command Line Tools and a code-signing identity. Use a stable bundle ID so macOS can retain its permissions.

```sh
SOURCE_SEARCH_SIGNING_IDENTITY="Your signing identity" \
SOURCE_SEARCH_BUNDLE_ID="org.example.your-source-search" \
sh native/scripts/build-helper.sh "$HOME/.local/share/source-search/native"
"$HOME/.local/share/source-search/native/context-macos-pim-disclaim" \
  "$HOME/.local/share/source-search/native/Context macOS PIM Helper.app/Contents/MacOS/context-macos-pim-helper" authorize calendar
```

The second command opens macOS's Calendar permission prompt. Use `authorize contacts` or `authorize reminders` for those sources. Keep an existing helper's signing identity and bundle ID when upgrading.

```json
{
  "calendar": {"adapter": "calendar"},
  "contacts": {"adapter": "contacts"}
}
```

`helper` and `launcher` can override the default paths shown above. Calendar searches require `from` and `to` timestamps; long ranges continue in bounded windows. Contacts have no date filter. These sources read current records directly. For exported files, use [iCalendar or vCard](#calendar-and-contact-files).

## Apple Reminders

Build and authorize the [native helper](#native-apple-calendars-and-contacts), using `authorize reminders`. Add a source to your private configuration and its ID to `enabledSources`:

```json
{
  "reminders": {"adapter": "tasks", "connector": {"type": "apple-reminders"}}
}
```

Run `bun run start task-lists reminders` to discover list IDs. To select particular lists, add `"lists": ["list-id"]` to the connector; omit it for all accessible lists. `helper` and `launcher` can override the default native paths. Enable `maintenanceEnabled`, then run `bun run start sync-tasks reminders` and search `all-tasks` or `reminders`.

[EventKit](https://developer.apple.com/documentation/eventkit/ekreminder) supplies open and completed reminders, list names, notes, dates, priority and recurrence. Tags, subtasks, smart-list membership and attachments are outside this connector's coverage. A full snapshot is compared on each refresh; unchanged records reuse their projections. Date-only due dates stay date-only. Apple can replace local IDs during an account resync; search again if an old reference no longer resolves.

## Microsoft To Do

[Microsoft To Do](https://learn.microsoft.com/en-us/graph/todo-concept-overview) is Microsoft's task app for Windows, web and mobile. This connector uses Microsoft Graph's public service for personal Microsoft accounts and work or school accounts with To Do enabled.

1. Create your own app registration in the [Microsoft Entra admin center](https://entra.microsoft.com/). Choose personal accounts, organization accounts, or both to match your use. Copy the application (client) ID.
2. Under **API permissions**, add Microsoft Graph's delegated **Tasks.Read** permission. Under **Authentication**, enable **Allow public client flows** for device-code sign-in. No client secret is needed.
3. Add this source to your private configuration, with your client ID and an absolute cache path. Add `microsoft-tasks` to `enabledSources` and enable `maintenanceEnabled`.

```json
{
  "microsoft-tasks": {"adapter": "tasks", "connector": {
    "type": "microsoft-todo",
    "account": "my-microsoft-account",
    "oauth": {
      "clientId": "11111111-1111-4111-8111-111111111111",
      "tenant": "common",
      "cache": "/absolute/private/credentials/microsoft.json"
    }
  }}
}
```

Run `bun run start login-microsoft microsoft-tasks` and follow the displayed sign-in instructions. [MSAL](https://learn.microsoft.com/en-us/entra/msal/javascript/node/caching) manages token refresh and saves its login cache in a private file (`0600` in a `0700` directory). Keep that directory outside the checkout and disposable cache. Use a separate `account` name and cache file for each Microsoft account. `tenant` can be `common`, `consumers`, `organizations`, or your tenant's UUID. An organization's sign-in policy may require administrator approval.

Run `bun run start task-lists microsoft-tasks` to discover lists. Add optional `"lists": ["list-id"]` alongside `oauth` to restrict indexing; omitted means all accessible lists. Then run `bun run start sync-tasks microsoft-tasks`. An existing credential manager can replace `oauth` with `"token": {"command": ["/absolute/token-helper", "read"]}`, or the usual environment/file credential. It must supply a current delegated Microsoft Graph access token with `Tasks.Read`; this is an OAuth access token, not a password or API key.

Open and completed tasks, notes, checklist steps, categories, dates, recurrence and linked resources are searchable. File attachment contents, Planner tasks and My Day membership are excluded. [Task deltas](https://learn.microsoft.com/en-us/graph/api/todotask-delta?view=graph-rest-1.0) handle additions, edits and deletions; list inventories detect list renames/removals. Expired delta history triggers a complete refresh. If the account rejects delta access with read permission, the connector uses complete snapshots and reports that strategy. Changed tasks refresh their steps and links; a full reconciliation on the first sync after 24 hours also catches changes absent from the delta feed. Original reads fetch the current task again. Graph can change an ID when a task moves between lists, so a moved task can require a new reference.

## Mail

Each mailbox has a stable local `account` name, an `email` for attribution, and optional `aliases`. Use the provider’s IMAP or JMAP connection settings.

For JMAP, get the session URL and credentials from your provider. Fastmail documents its [session URL](https://www.fastmail.com/dev/) and [API tokens](https://www.fastmail.help/hc/en-us/articles/5254602856719-API-tokens). Put the token alone in a private file, set its permissions to `0600`, and use this source definition under `sources`:

```json
{
  "work-mail": {
    "adapter": "jmap", "account": "work", "email": "user@example.com",
    "sessionUrl": "https://api.fastmail.com/jmap/session",
    "auth": {"type": "bearer", "token": {"file": "/absolute/private/mail-token"}}
  }
}
```

Add `work-mail` to `enabledSources`. The connector discovers the primary mail account; set `accountId` to select another accessible account. Servers using HTTP Basic authentication accept `auth: {"type":"basic","username":"user@example.com","password":{"file":"/absolute/private/path/password"}}`.

For IMAP, add a source like this and include its ID in `enabledSources`:

```json
{
  "other-mail": {
    "adapter": "imap",
    "account": "other",
    "email": "user@example.com",
    "host": "imap.example.com",
    "port": 993,
    "username": "user@example.com",
    "auth": {"type": "password", "password": {"file": "/absolute/private/path/app-password"}}
  }
}
```

Use your provider's IMAP settings and app password if required. For port 143, set `security: "starttls"`; the connection must upgrade to TLS. Private certificate authorities can be supplied with `caFile`. Certificates are always verified.

Credential commands run again for each connection, allowing an existing tool to refresh tokens. For IMAP OAuth, use `auth: {"type":"oauth2","accessToken":{"command":["/path/to/token-tool"]}}`. For mail, Source Search does not perform browser sign-in; provider token scopes and refresh remain the credential tool's responsibility.

### Search behavior

- Both connectors return newest first; `sort: "oldest"` reverses the order. `from` is inclusive and `to` exclusive, using the provider's received timestamp. Native searches do not offer relevance ranking.
- IMAP treats whitespace-separated terms as an AND. `match: "phrase"` searches the literal phrase. JMAP uses the server's text search; `words` and `phrase` request the corresponding protocol behavior. Word stemming, Unicode matching and indexed content depend on the server. Gmail query operators are specific to the Gmail connector.
- An optional source-level `folders` list restricts searches, original reads and thread context. A query's `folders` narrows that selection. `list_sources` reports folder names, IDs and roles. Unknown or ambiguous folders produce an error.
- Spam and trash are excluded by default; `excludeSpamTrash: false` includes them within the configured selection. IMAP uses server roles and recognized names. Set `folderRoles`, for example `{"Correo no deseado":"junk","Papelera":"trash"}`, for missing or localized roles. Missing roles produce a warning.
- IMAP merges results across folders and orders by received time, not UID order. Stable server IDs deduplicate copies; otherwise copies remain separate. Header `Message-ID` alone never removes a result. Without stable IDs, moved messages or changed mailbox identities need a new reference; stale references return an error.
- Continue `nextCursor` until absent. A changed result set requires restarting the query. IMAP sorts matching metadata locally, with a default ceiling of 20,000 candidates per search and a 30-second operation timeout. Broader requests fail explicitly: narrow dates/folders, or configure `maxSearchMessages` and `timeoutMs`. These limits also apply to optional library backfills.
- Reads fetch text and attachment names/types. Optional document maintenance downloads supported attachments through the same native connectors, with folder restrictions and byte limits. IMAP decodes MIME through mailparser without downloading attachment bodies. Its text budget is configurable with `maxMessageBytes` (10 MB by default). JMAP reports truncated or undecodable provider body values. IMAP thread context requires server-provided thread IDs; messages are never grouped by subject alone.

The connectors follow [JMAP Mail](https://www.rfc-editor.org/rfc/rfc8621.html) and use [ImapFlow](https://imapflow.com/docs/) for IMAP. Reads preserve message flags. Authentication failures, timeouts and provider failures are errors, not empty mailboxes.

### Existing mail CLIs

An already configured Gmail account can use the `gmail` adapter:

```json
{
  "gmail-mail": {"adapter": "gmail", "account": "work", "email": "user@example.com"}
}
```

Use the account name configured in `gog`. Set the top-level `gmailBinary` to its absolute executable path if it is unavailable on the MCP client's `PATH`. It must support `--gmail-no-send` and the commands and JSON responses in [mail/legacy.ts](../src/sources/mail/legacy.ts). Existing `fastmail` sources use the legacy `mailbridge` CLI. For new connections, prefer the IMAP or JMAP setup above.

## Connected service setup

The services below use explicit synchronization and local keyword search, with no search models required. Enable `maintenanceEnabled` and run `sync-sources SOURCE_ID`; Google Tasks uses `sync-tasks SOURCE_ID`. A library refresh also synchronizes enabled sources. Original reads check the current provider record and detect edits since the saved reference.

Use `source-lists SOURCE_ID` to discover collections where supported. Select `collections` for calendars/address books or `lists` for tasks; omitted selection means all accessible collections. Repository sources always require an explicit `repositories` selection.

Failed synchronization retains the previous complete snapshot and reports the failure. Provider rate limits include retry guidance. Connected services allow ten minutes and 10,000 requests per sync by default. Large imports can set `sync: {"timeoutMs": 1800000, "maxRequests": 20000}` alongside `adapter` and `connector`, up to one hour and 100,000 requests. Changing budgets preserves saved references.

## Google Tasks

Use a task connector with `type: "google-tasks"`, a stable `account` name, and optional `lists` containing selected task-list IDs. Authenticate with either `token: {"env": "GOOGLE_ACCESS_TOKEN"}` or `oauth: {"clientId": "YOUR_DESKTOP_CLIENT_ID", "clientSecret": {"file": "/absolute/private/client-secret"}, "cache": "/absolute/private/google-login.json"}`. Create a Desktop OAuth client in Google Cloud and enable the Tasks API. The client secret field is optional when your client supports token exchange without it.

Run `bun src/cli.ts login-google SOURCE_ID`, open the displayed sign-in URL, then use `task-lists SOURCE_ID` and `sync-tasks SOURCE_ID`. Login requests read-only Tasks access and uses a local callback; later syncs refresh silently. Completed, hidden and assigned tasks are included. Due dates are dates, as supplied by Google. Modified-since updates include deletions, with a complete daily reconciliation.

## Google and Outlook calendars and contacts

Add a source like this:

```json
{
  "work-calendar": {
    "adapter": "calendars",
    "window": {"pastDays": 730, "futureDays": 365},
    "connector": {
      "type": "google",
      "account": "work",
      "collections": ["calendar-id"],
      "oauth": {
        "clientId": "YOUR_DESKTOP_CLIENT_ID",
        "clientSecret": {"file": "/absolute/private/client-secret"},
        "cache": "/absolute/private/calendar-login.json"
      }
    }
  }
}
```

For Google, enable the Calendar API or People API in the OAuth client project. Run `login-google SOURCE_ID`. Use `adapter: "address-books"` for contacts and omit `window` and `collections`; Google saved contacts are one address book. Scopes are `calendar.readonly` or `contacts.readonly`. Other Contacts and organization directories are not included.

For Outlook, use `type: "microsoft"` and `oauth: {"clientId": "YOUR_APPLICATION_UUID", "tenant": "common", "cache": "/absolute/private/outlook-login.json"}`. Register a public client application with device code flow enabled, as described for [Microsoft To Do](#microsoft-to-do), and run `login-microsoft SOURCE_ID`. Delegated scopes are `Calendars.Read` or `Contacts.Read`. Personal and work/school accounts are supported. Address books include the default Contacts folder (`default`) and nested folders. Calendar and contact sources should use separate authentication caches unless the cache already has both permissions.

Either provider accepts `token` instead of `oauth`, using an environment variable, private file, or token command. Supply a current access token with the corresponding read scope. Keep `account` stable for one account and change it when switching accounts; rotating a credential does not invalidate saved references.

Calendar snapshots contain occurrences in the configured window, including recurring exceptions and all-day events. The window advances daily. Search outside it reports the coverage limit; widen it and synchronize to include older or future events. Google uses sync tokens. Outlook uses delta queries for its primary calendar and full bounded views for other calendars. Contacts use Google sync tokens or Outlook folder deltas. Expired tokens trigger a complete replacement scan. Contact search has no occurrence-date filters.

## CalDAV and CardDAV

Use `calendars` with `type: "caldav"`, or `address-books` with `type: "carddav"`:

```json
{
  "nextcloud-contacts": {
    "adapter": "address-books",
    "connector": {
      "type": "carddav",
      "account": "personal",
      "serverUrl": "https://cloud.example.com/remote.php/dav",
      "username": "user",
      "password": {"file": "/absolute/private/dav-app-password"}
    }
  }
}
```

Use your provider's DAV endpoint and app password. Fastmail uses `https://caldav.fastmail.com/` or `https://carddav.fastmail.com/`; Nextcloud provides its DAV URL in calendar/contact settings. `source-lists` discovers collection URLs; put selected URLs in `collections`. Calendar `window` works as above. `connector.timeZone` sets the IANA timezone for floating/all-day calendar values (UTC by default).

The [tsdav client](https://tsdav.vercel.app/intro/) handles DAV discovery, XML and synchronization. Supported servers use sync tokens, including deletions and expired-token recovery. Other servers use collection tags, fetching a full collection only when changed (or when no tag is available). Calendar objects are retained for local recurrence expansion; searchable occurrences stay inside the configured window. Some providers discover a different host; list its exact HTTPS origin in `allowedOrigins`, or configure the provider's final endpoint directly.

## Notion

Use `adapter: "notes"` with `connector: {"type": "notion", "account": "workspace", "token": {"env": "NOTION_TOKEN"}, "pages": ["PAGE_UUID"], "dataSources": ["DATA_SOURCE_UUID"]}`. Select at least one page or data source; either list may be omitted. Create a Notion connection with Read content capability and share the selected pages/databases with it. Database containers can have multiple data sources; use the data-source IDs from Notion's API.

Synchronization reads selected page properties and [Notion's markdown content](https://developers.notion.com/reference/retrieve-page-markdown), including nested blocks and continuation subtrees. Data sources include their current page rows; listing them reconciles deletions and moved rows. Unchanged page content is reused by revision, with a daily content refresh. Search `all-notes` or the named source. Inaccessible/unsupported embedded blocks produce coverage warnings. Comments, attachments and linked pages outside the selected content are not downloaded.

## Google Drive and OneDrive

Use `adapter: "files"` with selected `roots` (folder or file IDs) and `connector: {"type": "google", "account": "work", "oauth": {...}}` or the equivalent Microsoft connector. Google uses the same Desktop OAuth settings described above; enable the Drive API and run `login-google SOURCE_ID`. OneDrive uses Microsoft public-client settings and `login-microsoft SOURCE_ID`; optional `driveId` selects a particular drive. Run `source-lists SOURCE_ID` to list the drive root's immediate children and IDs. Use `roots: ["root"]` only when you intend to select the whole drive; otherwise replace it with specific folder/file IDs before synchronizing.

`content: "metadata"` is the default: names, descriptions, types, dates and links, without file downloads. `content: "text"` adds plain-text formats (including Markdown, HTML, JSON and CSV) and Google Docs exports. PDF, Office, images and other binary formats remain metadata-only and appear in coverage warnings. Text downloads default to an 8 MiB limit (`maxTextBytes`). No OCR, attachment extraction or embedding is started by this setting. Enable the optional library separately for semantic search.

Known ebook formats are excluded. `excludeNames` accepts filename/folder globs and defaults to `Books` and `Ebooks`, matched without case sensitivity. Use it to exclude PDF books or other unwanted folders; file type alone cannot distinguish a PDF book from another PDF document. Shortcuts are metadata only, so they cannot expand folder selection.

Both connectors poll provider change feeds. A relevant change triggers a fresh metadata inventory of selected folders; unchanged file text is reused by revision. A daily reconciliation checks moves, deletions and permissions. Change feeds may contain metadata outside the selected folders; only selected records are retained or downloaded. Original reads check the current folder ancestry. OneDrive's temporary download URLs are used immediately without forwarding credentials and are never saved in snapshots.

## GitHub and Linear

Use `adapter: "issues"`. GitHub's connector is `{"type": "github", "account": "work", "token": {"env": "GITHUB_TOKEN"}, "repositories": ["owner/repository"]}`. Use a fine-grained token with read access to Issues and Pull requests for those repositories. GitHub Enterprise can set `apiUrl` to its HTTPS REST base, such as `https://github.example.com/api/v3`. Source Search reads open/closed issues, pull request descriptions, issue comments and inline review comments; inline review comments include their quoted code context.

Linear's connector is `{"type": "linear", "account": "work", "token": {"env": "LINEAR_API_KEY"}, "teams": ["TEAM_UUID"]}`. Optional `projects` restricts those teams to selected project UUIDs. Personal API keys use the default `authMode: "api-key"`; an externally refreshed OAuth access token uses `authMode: "oauth"` with read scope. `source-lists SOURCE_ID` lists accessible team IDs. Issues include archived items and comments, with team/project attribution.

Run `sync-sources SOURCE_ID`, then search the source or `all-issues`. `conversation` filters one issue (`owner/repository#123` or `TEAM-123`). Issue and comment updates are polled independently with a timestamp overlap, because editing a comment need not update its parent issue. Complete daily reconciliation removes deleted records and catches moved issues. Saved references open the current issue or comment and enforce the selected repository/team/project.

## GitHub repository files

Choose `repositories` in `bun run start setup`, or add a named source to your private configuration:

```json
{
  "enabledSources": ["project-code"],
  "maintenanceEnabled": true,
  "sources": {
    "project-code": {
      "adapter": "repositories",
      "connector": {
        "type": "github",
        "account": "work",
        "token": {"file": "/absolute/private/github-token"},
        "repositories": [
          "your-org/application",
          {"name": "your-org/shared-library", "branch": "release/v2"}
        ]
      }
    }
  }
}
```

Use a fine-grained GitHub token with **Contents: read** for the selected repositories. `token` also accepts an environment variable or an existing credential command. Set `connector.apiUrl` to an HTTPS REST base for GitHub Enterprise, such as `https://github.example.com/api/v3`. Keep `account` stable for one account; changing credentials alone preserves references.

To discover repository names first, set `repositories: []`, enable this source, and run `bun run start source-lists project-code`. Discovery lists repositories visible to the authenticated user; it does not select or index them. Copy only the desired `owner/name` values into `repositories`. Empty selection cannot synchronize. You can also enter a known public repository directly, even if it does not appear in your account's list.

A string follows that repository's default branch. An object selects an exact branch, including names containing slashes. Select each repository once per source; use another source ID for another branch or for separate per-repository queries. Repositories need an initial commit on the selected branch. Issues and pull requests remain separate `issues` sources.

```sh
bun run start sync-sources project-code
bun run start search '{"queries":[{"source":"project-code","query":"createClient"}]}'
bun run start search '{"queries":[{"source":"all-repositories","query":"export function","match":"phrase"}]}'
```

Search matches file paths and content using the same word-prefix and literal-phrase rules as other local sources. It works without a clone, GitHub code-search indexing or search models. `all-repositories` combines repository sources; `all-files` also includes cloud file sources. Optional library indexing adds semantic/hybrid search. Dates are not inferred from the latest repository commit, so repository sources support relevance ordering and no date filter.

Tracked UTF-8 text includes code, configuration, documentation and hidden paths such as `.github/`. Defaults exclude dependency/build folders (`node_modules`, `vendor`, `dist`, `build`, `coverage`, `.git`), minified JavaScript, source maps and package-manager lockfiles. Set `include` and `exclude` alongside `adapter` to replace these glob lists; for example, `"include": ["src/**/*.ts", "README.md", "docs/**"]`. Patterns are relative to the repository root. Books, binary files, symlink targets, submodules and Git LFS contents are excluded. Git LFS pointers are skipped too.

Each file defaults to at most 1 MiB (`maxFileBytes`, configurable up to 8 MiB). Total text defaults to 32 MiB per source (`maxTotalBytes`, up to 48 MiB). Coverage reports skipped files. If a complete snapshot exceeds its total size or request budget, synchronization fails and retains the previous snapshot; narrow the selected paths/repositories or adjust the limits.

Synchronization checks each selected branch head. Unchanged heads reuse the saved snapshot; changed heads read a complete tree and download only new blob revisions. Deletions, renames and force pushes reconcile against that tree. A truncated recursive GitHub tree is expanded through its pinned subtrees before publishing. Commit history is not indexed.

Results link to the file at the observed commit. `read_record` checks the file currently on the selected branch and reports a stale reference if it changed. Unrelated commits and adding another selected repository preserve unchanged file references. After changing repository/path selection, synchronize before searching again. Removed repositories are then excluded from both search and original reads.

## Slack

Use `adapter: "chat"` with a connector such as:

```json
{
  "type": "slack",
  "account": "work",
  "workspace": "T_WORKSPACE_ID",
  "channels": ["C_CHANNEL_ID"],
  "token": {"file": "/absolute/private/slack-token"},
  "historyDays": 90
}
```

Replace the placeholder workspace/channel IDs with Slack's actual IDs (for example, from the client URL). Create or use a Slack app with read scopes for the selected channel types: `channels:read`/`channels:history`, `groups:read`/`groups:history`, `im:read`/`im:history`, or `mpim:read`/`mpim:history`. `users:read` supplies display names; without it, IDs remain searchable. Bot tokens can read conversations the bot belongs to; user tokens follow the user's access. The connector verifies the token's workspace before reading channels. It does not join channels or request additional permissions during synchronization.

Run `sync-sources SOURCE_ID`, then search the source or `all-chats`. `conversation` filters a channel ID. History includes thread roots within `historyDays` and their replies, message text, rich-text fallbacks and file names/types. File contents are not downloaded. Slack's plan and retention limits still apply.

Sync revisits recent seven-day history and known threads, catching edits and reply deletions. A full daily reconciliation catches older edits/deletions and first replies to old roots. Threads rooted outside the configured window require a larger `historyDays`. Requests are paced; rate-limit or permission failures retain the previous complete snapshot and report the error. Original reads fetch the exact current message, including thread replies.
