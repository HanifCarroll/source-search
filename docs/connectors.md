# Connected sources

These connectors share explicit synchronization and local keyword search. They need no search models. Add source definitions under `sources`, include only the IDs you want in `enabledSources`, and set `maintenanceEnabled: true`. New sources start disabled. Credentials and authentication caches belong outside the repository.

Run `bun run start source-lists SOURCE_ID` to discover calendars, address books or task lists where supported. Select IDs in `collections` for calendars/address books or `lists` for tasks; omitted means all accessible collections. Run `bun run start sync-sources SOURCE_ID` for connected sources or `sync-tasks SOURCE_ID` for tasks. A library refresh also synchronizes enabled sources. Original reads check the current provider record and detect edits since the saved reference.

If synchronization fails, search retains the previous complete snapshot and reports the failure. Provider rate limits are reported with retry guidance; rerun synchronization later. Checkpoints and record changes are saved together.

Connected sources allow ten minutes and 10,000 requests per sync by default. Large initial imports can set `sync: {"timeoutMs": 1800000, "maxRequests": 20000}` alongside `adapter` and `connector`. Limits can be raised to one hour and 100,000 requests. Changing these budgets preserves saved references; it does not change provider rate limits or selected content.

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

For Outlook, use `type: "microsoft"` and `oauth: {"clientId": "YOUR_APPLICATION_UUID", "tenant": "common", "cache": "/absolute/private/outlook-login.json"}`. Register a public client application with device code flow enabled, as described for Microsoft To Do in the README, and run `login-microsoft SOURCE_ID`. Delegated scopes are `Calendars.Read` or `Contacts.Read`. Personal and work/school accounts are supported. Address books include the default Contacts folder (`default`) and nested folders. Calendar and contact sources should use separate authentication caches unless the cache already has both permissions.

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
