# Local Serve API

`decant serve` runs the archive owner, source watcher, local HTTP API,
Server-Sent Events stream, and React UI in one Bun process. It listens on
`http://127.0.0.1:3000` by default.

The reference contract is [openapi.yaml](openapi.yaml). It describes every
`/api/*` operation, parameter, request body, response schema, and stable error
code. A running server exposes the same OpenAPI 3.1 document as JSON at
`GET /api/openapi.json`; its `info.version` is the running Decant version.

This page records the operational semantics around that contract.

## UI routes

- `GET /` (Analytics; grouped under Overview in the sidebar)
- `GET /projects`
- `GET /sessions`
- `GET /sessions/:id`
- `GET /search`
- `GET /analytics`
- `GET /insights`
- `GET /tools`
- `GET /files`
- `GET /settings`
- `GET /reports/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /reports/session/:id`

The report UI routes render a light, print-ready preview with Back, Download
HTML, and Save as PDF controls. They read the local-only report operations;
the session preview intentionally omits transcript content.

## Access control

The API has no authentication. Any request that reaches the listener and passes
the local guard can read or mutate the whole archive.

- The default loopback bind admits local processes only.
- On a non-loopback bind, loopback source addresses and the trusted peers
  resolved at startup are admitted; every other source receives
  `403 forbidden_remote`.
- Trusted-peer sources use replacement precedence, not a union. The first
  present source wins: `--trusted-peer`, then `DECANT_TRUSTED_PEERS` whenever
  the variable is set, then `DECANT_TRUST_DEFAULT_GATEWAY=1`.
  `DECANT_TRUSTED_PEERS=` therefore means “trust nobody,” not “fall through.”
- The gateway option contributes one address only when Decant proves the
  default route is a container veth to an on-link gateway inside
  `172.16.0.0/12`. It fails closed for host networking, macvlan/ipvlan,
  multi-homed hosts, and other unproven shapes. See
  [distribution.md](../distribution.md#docker).
- The `Host` check is not authentication: a non-browser client can send
  `Host: localhost`. The `Origin` and `Sec-Fetch-Site` checks on writes are
  browser-drive protections, not credentials.

On a loopback bind, a command-line write may omit `Origin`. On a non-loopback
bind, a write that supplies neither `Origin` nor `Sec-Fetch-Site` is rejected
even when the source is trusted. Supply a loopback `Origin` for an explicit
command-line write; for example:

```bash
curl --fail --silent --show-error \
  --request POST \
  --header 'Content-Type: application/json' \
  --header 'Origin: http://127.0.0.1:3000' \
  --data '{}' \
  http://127.0.0.1:3000/api/sync
```

If the client connects to a non-loopback address directly, it must also send a
loopback `Host` header. Admission still depends on the actual source address;
changing `Host` or `Origin` never makes an untrusted peer trusted.

## Response and archive semantics

JSON errors use the stable envelope `{ "error": string, "code": string, ... }`.
Expected recovery cases retain specific codes, including `archive_locked`,
`schema_drift`, `schema_too_new`, `schema_too_old`, `session_not_found`, and
validation failures. Unexpected failures return generic `internal_error` prose;
the structured stderr log retains the diagnostic.

`DECANT_NO_SYNC` and `--no-sync` suppress Decant-initiated startup, watch, and
sweep syncs. They do not disable `POST /api/sync`.

Session archive/delete state is local metadata. Archiving hides a session from
default lists, searches, and aggregate statistics. The `include_archived`
parameter on session-list and statistics operations opts it back into those
operations; full-text and command-palette search remain limited to visible
sessions. Deletion creates a tombstone keyed to source identity, so a later sync
does not restore the session. Neither operation modifies the source JSONL file.

Report operations return self-contained, zero-JavaScript HTML. Session reports
omit transcript content by design.

### Session listing and command-palette index

`GET /api/sessions` returns a bare newest-first array, not an envelope with a
total or continuation token. Its `limit` defaults to 50 and has an effective
maximum of 100. Increment `offset` by the number of rows received; a final short
or empty page marks the end. When the result count is an exact multiple of the
page size, one empty request is required to confirm the end.

`GET /api/sessions/search-index` returns lightweight metadata for every visible,
non-archived top-level session. It is the command palette's local fuzzy-search
haystack and intentionally omits transcript content.

## Server-Sent Events

`GET /api/events` returns `text/event-stream`. The current event names are:

- `hello` — connection acknowledgement
- `ping` — heartbeat, normally every five seconds
- `ready` — source watcher initialized
- `sync_progress` — bounded progress snapshot for a running sync
- `sync` — terminal successful sync report
- `archive_updated` — archive-derived UI data changed
- `error` — watcher or sync failure
- `stopped` — source watcher stopped

Each `data` field is JSON and includes a matching `type`. The OpenAPI operation's
`x-sse-events` extension defines the payload schema for each name.
