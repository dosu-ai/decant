# Local Serve Routes

`decant serve` runs the CLI, watcher, JSON routes, SSE stream, and React UI in
one Bun process. These routes are internal app routes, not a versioned public
contract. By default, the server listens on `http://127.0.0.1:3000`.

## Access control

Every route is unauthenticated: anything that reaches the port and passes the
guard reads or writes the whole archive.

- Bound to loopback (the default), only local processes can connect.
- Bound to a non-loopback host (`--host 0.0.0.0`, as the container image does),
  the peer's source address is the boundary. Loopback peers pass, and so do the
  trusted peers resolved at startup. Everything else gets `403 forbidden
  remote`.
- Trusted peers come from exactly one source, highest first, each replacing the
  ones below rather than adding to them: `--trusted-peer`, then
  `DECANT_TRUSTED_PEERS` whenever that variable is set at all, then
  `DECANT_TRUST_DEFAULT_GATEWAY=1`. All are unset by default outside the
  container image, so nothing beyond loopback is trusted until an operator opts
  in.
- `DECANT_TRUST_DEFAULT_GATEWAY=1` contributes a single address, the container's
  own bridge gateway, and only when the default route is a container veth
  pointing at an on-link gateway inside `172.16.0.0/12`; see
  `docs/distribution.md`. Every other shape, including `--network host` and
  macvlan, contributes nothing.
- The `Host` check that returns `403 forbidden host` is not an access control
  for non-browser clients: `curl -H 'Host: localhost'` satisfies it. Neither are
  the `Origin`/`Sec-Fetch-Site` checks on mutating routes, which only stop a
  browser on another site from driving this API.

## UI

- `GET /`
- `GET /projects`
- `GET /sessions/:id`
- `GET /search`
- `GET /analytics`
- `GET /insights`
- `GET /tools`
- `GET /files`
- `GET /settings`

## JSON

- `GET /api/health`
- `GET /api/config`
- `GET /api/settings`
- `POST /api/settings`
- `GET /api/sync-status`
- `GET /api/metadata/sync-status`
- `POST /api/sync`
- `GET /api/sessions?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/sessions/:id`
- `GET /api/sessions/:id/token-economics`
- `GET /api/sessions/:id/context-window`
- `GET /api/projects`
- `POST /api/search`
- `GET /api/stats/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/stats/by-dimension?dim=tool|model|project|day&from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/analytics/activity?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/analytics/model-sparklines?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/analytics/token-economics?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/analytics/now`
- `GET /api/date-bounds`
- `GET /api/metadata/date-bounds`
- `GET /api/files?group=path|ext&op=read|edit|write|delete&from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/tools/usage?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/tools/mcp-usage?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/recommendations?status=open|implemented|all`
- `POST /api/recommendations/mark`
- `POST /api/launch/agent`
- `POST /api/launch/ide`

Session and archive token-economics routes aggregate versioned per-session
vectors persisted during ingest. The first sync after a schema upgrade
backfills vectors for unchanged sessions.

The context-window route derives per-API-call window occupancy and compaction
events at read time from persisted per-message token columns and raw records.
Claude window sizes are inferred (200k, or 1M once usage exceeds 200k) because
those logs do not state them; Codex rollouts carry an explicit
`model_context_window`, persisted on the session's `raw_meta`. Session rows
also carry materialized rollups (`context_window_tokens`,
`peak_context_tokens`, plus the existing `compaction_count`) computed at ingest; the
first sync after a schema upgrade backfills them, like the economics vectors.
Codex sessions ingested by older decant builds, as well as source rollouts
predating `last_token_usage`, return empty `points` until the source changes
and is re-ingested or the archive is rebuilt.

## Events

- `GET /api/events` returns an SSE stream.

Current event names:

- `hello`
- `ready`
- `sync`
- `archive_updated`
- `error`
- `stopped`
