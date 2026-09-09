# Local API recipes

These examples use Decant's local, unauthenticated API. Keep it on loopback
unless you deliberately configured the trusted-peer boundary in
[Local Serve API](routes.md).

The reference schema is [openapi.yaml](openapi.yaml). The running binary serves
the same document at `/api/openapi.json`.

## Start a read-only snapshot server

Use `--no-sync` when you want to analyze the archive as it exists without a
startup sync or source watcher:

```sh
decant serve --no-sync --no-open
```

This does not make write routes read-only. An explicit `POST /api/sync` still
runs, and admitted clients can still change session state or recommendations.

Set a base URL for the examples:

```sh
BASE=http://127.0.0.1:3000
```

## Check freshness before analysis

```sh
curl --fail --silent --show-error "$BASE/api/health"
curl --fail --silent --show-error "$BASE/api/sync-status"
curl --fail --silent --show-error "$BASE/api/date-bounds"
```

`sync-status` reports whether a sync is in progress, its last terminal report,
and its last error. For a reproducible snapshot, wait for `in_progress` to be
false or start the server with `--no-sync` before collecting endpoints.

## Query a complete date window

`from` and `to` are inclusive UTC dates. Exclude the current UTC date when you
want complete days, then compare with an equal-length preceding window.

```sh
FROM=2026-07-04
TO=2026-08-02

curl --fail --silent --show-error --get \
  --data-urlencode "from=$FROM" \
  --data-urlencode "to=$TO" \
  "$BASE/api/stats/summary"
```

Group the same scope without changing its denominator:

```sh
curl --fail --silent --show-error --get \
  --data-urlencode "dim=project" \
  --data-urlencode "from=$FROM" \
  --data-urlencode "to=$TO" \
  "$BASE/api/stats/by-dimension"
```

Available dimensions are `tool`, `model`, `project`, and `day`. Aggregate
`sessions` counts top-level sessions; token, cost, message, and tool totals
include visible subagents. See [How Decant analytics work](../analytics-methodology.md).

## Paginate sessions

`GET /api/sessions` returns a bare newest-first array. Its default limit is 50
and its effective maximum is 100. Increase `offset` by the number of rows
received until a page is short or empty:

```sh
curl --fail --silent --show-error --get \
  --data-urlencode "from=$FROM" \
  --data-urlencode "to=$TO" \
  --data-urlencode "limit=100" \
  --data-urlencode "offset=0" \
  "$BASE/api/sessions"
```

When the total is an exact multiple of the page size, one empty request is
required to confirm the end. There is no total or continuation token in this
response.

Use `include_subagents=true` to return subagents as rows. Use
`with_subagents=true` to attach nested summaries to top-level rows, capped at
five levels. For a complete tree, request subagents as rows and join them by
`parent_session_id`. Do not add parent cost and archive-wide cost totals
together: aggregate statistics already include every visible run.

## Economics, activity, tools, and files

The same date query works on the analytical endpoints:

```sh
curl --fail --silent --show-error \
  "$BASE/api/analytics/token-economics?from=$FROM&to=$TO"
curl --fail --silent --show-error \
  "$BASE/api/analytics/activity?from=$FROM&to=$TO"
curl --fail --silent --show-error \
  "$BASE/api/tools/usage?from=$FROM&to=$TO"
curl --fail --silent --show-error \
  "$BASE/api/tools/mcp-usage?from=$FROM&to=$TO"
curl --fail --silent --show-error \
  "$BASE/api/files?group=path&from=$FROM&to=$TO"
```

Activity distributions use the machine's local timezone and include subagent
starts. Avoid presenting their peak hour or weekday as a human work schedule
without first checking for a highly parallel session tree.

## Filter one project safely

Project filters require the exact archived path. Let `curl` encode it:

```sh
PROJECT=/path/to/project

curl --fail --silent --show-error --get \
  --data-urlencode "project=$PROJECT" \
  --data-urlencode "from=$FROM" \
  --data-urlencode "to=$TO" \
  "$BASE/api/stats/summary"
```

## Read one session without over-fetching

Session detail supports message pagination. Pass `message_limit=0` only when
you intentionally want the complete transcript; otherwise request the slice
needed by the client. Separate endpoints expose token economics, context-window
history, outline, and ingest issues:

```sh
SESSION_ID=123

curl --fail --silent --show-error \
  "$BASE/api/sessions/$SESSION_ID?message_limit=100&message_offset=0"
curl --fail --silent --show-error \
  "$BASE/api/sessions/$SESSION_ID/token-economics"
curl --fail --silent --show-error \
  "$BASE/api/sessions/$SESSION_ID/context-window"
curl --fail --silent --show-error \
  "$BASE/api/sessions/$SESSION_ID/issues"
```

## Handle errors by code

JSON failures use `{ "error": string, "code": string, ... }`. Branch on the
stable code, not prose. Expected recovery cases include `service_starting`,
`archive_locked`, `schema_drift`, `schema_too_new`, `schema_too_old`, and
`session_not_found`. `service_starting` and `archive_locked` are retryable;
schema conflicts require operator action.

Mutating routes also enforce content-type and browser-origin rules. Follow the
write example and trusted-peer details in [Local Serve API](routes.md) rather
than weakening those guards in a client.
