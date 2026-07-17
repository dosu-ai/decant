# Local Serve Routes

`decant serve` runs the CLI, watcher, JSON routes, SSE stream, and React UI in
one Bun process. These routes are internal app routes, not a versioned public
contract. By default, the server listens on `http://127.0.0.1:3000`.

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
Sessions without per-message usage (Codex rollouts predating
`last_token_usage`) return empty `points`.

## Events

- `GET /api/events` returns an SSE stream.

Current event names:

- `hello`
- `ready`
- `sync`
- `archive_updated`
- `error`
- `stopped`
