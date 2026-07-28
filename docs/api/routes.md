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

- `GET /` (Analytics; the sidebar groups this under Overview)
- `GET /projects`
- `GET /sessions`
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
- `POST /api/sync` (works even under `--no-sync`, which only stops the watcher)
- `GET /api/sessions?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/sessions/:id`
- `GET /api/sessions/:id/outline`
- `GET /api/sessions/:id/issues` — ingest diagnostics recorded for the session's
  source file
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

Session detail accepts `message_limit` and `message_offset` for transcript
pagination. The outline route returns lightweight entries for each human/prompt
turn and verified Dosu MCP call: sequence number, kind, ordinal, and either a
short prompt excerpt or normalized tool name. This lets sticky thread
navigation cover the whole session and point to Dosu optimizations without
loading every rich transcript block up front.

Session detail also returns `totals`, holding `reply_count` and
`tool_call_count` aggregated across the whole session rather than the requested
page, so a client can report them without loading every message. A reply is an
assistant message carrying at least one renderable block, matching what the UI
draws. The nested `subagents` entries carry structure and a summary but no
messages, so they omit `totals` along with the paging fields.

Session summaries returned by the list and detail routes include
`reasoning_effort` and `reasoning_effort_levels`. The first is the normalized
provider effort label, `mixed` when the setting changes between turns, or
`null` when the source did not record one. The levels array preserves the
unique labels represented by `mixed`. Provider labels retain their meaning
after whitespace trimming and canonicalization of known labels: Claude Code's
`max` remains `max`, while Codex's distinct `max` and `ultra` values also
remain unchanged. The current known values are:

- Claude Code: `low`, `medium`, `high`, `xhigh`, and `max`. Its `auto`
  selector resolves to the model default, while `ultracode` reports `xhigh`
  because it is workflow orchestration layered on that effort level. Numeric
  Agent SDK per-agent token budgets are preserved and displayed as token
  budgets.
- Codex: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and
  `ultra`. Unknown future custom values preserve their original spelling
  rather than being discarded or rewritten.

Availability remains model-dependent for both providers.

Claude Code began recording the active effort on every assistant transcript
message in v2.1.219. Earlier transcripts do not contain enough information to
distinguish the model default from a session override, so the UI keeps the
placeholder `-` and explains the missing source data in a tooltip instead of
guessing a historical effort level.

The context-window route derives per-API-call window occupancy and compaction
events at read time from persisted per-message token columns and raw records.
Claude logs do not state the size, so it is inferred from the recorded model:
Opus 5, Opus 4.6-4.8, Sonnet 5, Sonnet 4.6, Fable 5, and Mythos 5/Preview use
1M; other Claude models use 200k unless observed usage proves a historical 1M
session. Codex rollouts carry an explicit `model_context_window`, persisted on
the session's `raw_meta`, and that runtime value takes precedence over a
model's general API limit. Session rows also carry materialized rollups
(`context_window_tokens`, `peak_context_tokens`, plus the existing
`compaction_count`) computed at ingest; the first sync after a schema upgrade
backfills them, like the economics vectors.
Codex sessions ingested by older decant builds, as well as source rollouts
predating `last_token_usage`, return empty `points` until the source changes
and is re-ingested or the archive is rebuilt.

## Events

- `GET /api/events` returns an SSE stream.

Current event names:

- `hello`
- `ping` (heartbeat, emitted every 5 seconds)
- `ready`
- `sync`
- `archive_updated`
- `error`
- `stopped`
