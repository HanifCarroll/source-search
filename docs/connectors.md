# Connected sources

These connectors share explicit synchronization and local keyword search. They need no search models. Add source definitions under `sources`, include only the IDs you want in `enabledSources`, and set `maintenanceEnabled: true`. New sources start disabled. Credentials and authentication caches belong outside the repository.

Run `bun run start source-lists SOURCE_ID` to discover calendars, address books or task lists where supported. Select IDs in `collections` for calendars/address books or `lists` for tasks; omitted means all accessible collections. Run `bun run start sync-sources SOURCE_ID` for connected sources or `sync-tasks SOURCE_ID` for tasks. A library refresh also synchronizes enabled sources. Original reads check the current provider record and detect edits since the saved reference.

If synchronization fails, search retains the previous complete snapshot and reports the failure. Provider rate limits are reported with retry guidance; rerun synchronization later. Checkpoints and record changes are saved together.

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
