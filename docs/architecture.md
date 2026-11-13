# Architecture

Decant is one local Bun and TypeScript application. The CLI process discovers
coding-agent logs, normalizes and enriches them, owns the SQLite archive, and
optionally serves the React UI and local API. There is no hosted service, bearer
token, or second application process. The optional background service is
launchd or systemd running that same `decant serve` at login, not a separate
daemon.

## Data flow

```text
~/.claude + ~/.codex + ~/.gemini + ~/.local/share/opencode/opencode.db
  + ~/.cursor/chats/<workspace>/<chat>/store.db
  + ~/.copilot/session-state/<session>/events.jsonl
  + <VS Code User>/workspaceStorage/<id>/chatSessions/<session>.jsonl
  + ~/.decant/atif/**/*.json (ATIF trajectories, such as Harbor jobs)
        |
        v
discover -> parse -> normalize -> enrich -> ingest
                                      |       |
                                      |       +-> SQLite WAL + FTS5
                                      +-> cost, context, files, tools,
                                          diagnostics, economics vectors
                                                     |
                          +--------------------------+------------------+
                          |                          |                  |
                          v                          v                  v
                     CLI queries              local API + SSE       React UI
```

Source logs remain the source of truth. The archive is a rebuildable local
index plus local user state such as recommendations and session tombstones.

## Main modules

| Area | Primary modules | Responsibility |
| --- | --- | --- |
| Composition | `src/cli.ts`, `src/cli/`, `src/config.ts`, `src/settings.ts`, `src/update.ts`, `src/doctor.ts` | Commands, global flags, output policy, configuration, saved UI settings, the opt-in release check and `decant update`, the redacted `decant doctor` report, and process lifecycle. |
| Sources | `src/sources/`, `src/model.ts` | Pure, print-free parsers and the normalized wire model. |
| Ingest | `src/ingest.ts`, `src/enrich.ts`, `src/diagnostics.ts` | Discovery, change detection, normalization writes, derived facets, and ingest issues. |
| Economics | `src/cost.ts`, `src/model-usage.ts`, `src/billed-requests.ts`, `src/buckets.ts`, `src/token-economics.ts`, `src/context-window.ts` | Pricing, per-model usage splits, one billing session per copied Claude Code request, activity attribution, persisted vectors, and occupancy timelines. |
| Storage | `src/db.ts`, `src/schema.sql`, `src/schema-manifest.ts` | SQLite ownership, WAL, migrations, permissions, and schema-drift detection. |
| Reads | `src/query.ts`, `src/stats.ts`, `src/source-filter.ts`, `src/project-scope.ts`, `src/recommendations.ts`, `src/distill.ts`, `src/export.ts`, `src/export-atif.ts`, `src/atif-mirror.ts` | Session retrieval, aggregates, the Analytics source scope, resolving a typed project or repository to stored keys, recommendations, deterministic artifacts, Markdown, JSON, trajectory, and ATIF exports, and the ATIF folder mirror. |
| Serve | `src/server.ts`, `src/server/`, `src/route-paths.ts`, `src/watch.ts`, `src/*-worker.ts` | HTTP routing, trusted peers, sync coordination, SSE, and background worker execution. |
| Presentation | `src/ui/`, `src/report/` | The local React application and self-contained HTML reports. |

Core modules return data or structured failures. Human-readable output and exit
codes belong in `src/cli.ts` and `src/cli/`; HTTP status and error-envelope
policy belong in `src/server/`.

Every CLI failure leaves through one function, `fail` on the command context in
`src/cli/context.ts`, which prints either an `error:` line or the `--json` error
object described in [CLI output, errors, and exit codes](cli.md). A command
reports a failure by throwing a `CliError` from `src/cli/errors.ts`, or by
writing an `error:` line and returning an exit code. Flag and argument values
are checked in `src/cli/parse.ts` before a command's action runs.

## Parsing and ingest

Each source file produces one normalized session. OpenCode keeps every
session in one SQLite database, so there each session is a virtual source
`<database path>#<session id>`: `src/sources/opencode-store.ts` opens the
database read-only (never writing or checkpointing it), lists sessions from
both OpenCode's 2.x tables and its 1.x tables, and hands plain rows to the
pure parser for that layout (`src/sources/opencode.ts` or
`src/sources/opencode-legacy.ts`). When one session has copies in both layouts
or in several databases, ingest reads the copy updated last, preferring 2.x on
a tie within one database. A 2.x session that OpenCode migrated from 1.x is
handed to the 2.x parser with its 1.x copy, whose per-step usage corrects the
migrated rows. A Cursor CLI chat is one SQLite store per chat:
`src/sources/cursor.ts` opens it read-only, follows the root blob's list of
message blobs, and parses them. Ingest treats the store, its `meta.json`, and
its `-wal` as one source file for change detection. A GitHub Copilot CLI
session is one `events.jsonl` event log per session directory, parsed by
`src/sources/copilot.ts`. A Copilot Chat in VS Code session is one file in a
window's storage: `src/sources/vscode-copilot.ts` replays the `.jsonl` change
log, or reads the older whole `.json` file, into one session object. Ingest
reads the workspace's `workspace.json` to name the project. An ATIF file can
hold a root trajectory and embedded subagents: `src/sources/atif.ts` returns
one session for each, and ingest files the root under the file's path and each
subagent under `<file>#<trajectory_id>`, removing a subagent the file no longer
holds. Parsers retain canonical raw records while mapping
provider-specific roles, blocks, usage, tool calls, and lineage into shared
tables. Malformed lines and unknown record types become diagnostics rather than
aborting the file.

Ingest uses file size and modification time to avoid unnecessary work on JSONL
sources, and a per-session change key for OpenCode sessions, stored in
`ingest_source.hash` and built per layout from the session's update time and
its message (and, for 1.x, part) counts and update times; see
[data lifecycle](data-lifecycle.md). A changed session is replaced
transactionally, then Decant materializes context-window rollups and versioned
per-session economics vectors. Costs are also stored at ingest and reconciled
with current rates on every sync while transcripts and user state remain
intact. Reading a foreign database does not change Decant's own rule that one
process owns the archive; the OpenCode database stays OpenCode's.

The supported extension point is a new parser under `src/sources/`. Follow
[Add a source](adding-a-source.md); it defines the privacy, capability,
fixture, ingest, and golden requirements.

## SQLite ownership and schema

The active CLI process opens the archive directly. WAL mode permits concurrent
reads and the worker-owned ingest connection, but Decant does not put another
daemon or API process in front of SQLite.

`src/schema.sql` is the effective baseline, and `LATEST_SCHEMA_VERSION` in
`src/db.ts` is the source of truth for its version. Supported archives migrate
forward; older archives are rebuild-only. A migration is immutable once
committed because someone may already have opened an archive with that branch.
Schema manifests detect missing, unexpected, or structurally different owned
objects before Decant continues on a drifted archive.

Archive files and sidecars are created or narrowed to owner-only permissions
where the platform supports POSIX modes.

### Planner statistics

The query planner needs `sqlite_stat1` rows to choose good indexes, and a new
archive has none. Without them, per-message block lookups go through
`idx_block_type` and a first sync slows down with the square of the archive
size. Sync therefore runs `PRAGMA optimize` between session files every 25
ingested sessions. SQLite skips the work unless a table is unanalyzed or has
grown 25x since its last `ANALYZE`, so the calls after the first are close to
free. Sync also runs `PRAGMA optimize` once more after the ingest loop.

A connection reads statistics only when it loads the schema, so it does not
see rows another connection writes. The serve connection runs
`PRAGMA optimize=0x10002` when it opens, and after each worker sync that
ingested sessions it rereads its schema to load the statistics that the worker
wrote. The optimize step skips a read-only archive or a write lock held past
the busy timeout, because statistics only affect query speed.

A first sync can run for minutes while the dashboard polls, so serve's
connections also load statistics during a sync. On each progress update that
reports more ingested sessions, serve compares the archive's `sqlite_stat1`
rows with the ones its connections loaded. When they differ, the serve
connection rereads its schema with `PRAGMA writable_schema = RESET`, which
needs no write lock while the worker is writing, and each read worker reopens
its connection. The next reload waits until the sync has ingested twice as many
sessions, so a sync of any size reopens the read connections only a few times.
A sync into an archive whose statistics are current reloads nothing until it
ends.

FTS5 runs its own SQL against its shadow tables, so these statistics steer
full-text maintenance too. An analysis of an empty or near-empty index records
a row count for `block_fts_data` at which SQLite scans the table to delete a
merged segment, and every later merge would read the whole index. After each
`PRAGMA optimize`, a recorded count under 1,000 rows is replaced with
1,048,576, the estimate SQLite uses for a table it has never analyzed.

## Serve, workers, and caches

`decant serve` binds the HTTP listener before opening the archive. This makes a
second server fail with a truthful port-in-use message instead of first
becoming another database owner.

The server keeps request handling responsive by running source syncs in
`src/sync-worker.ts`, economics-vector scans in `src/stats-worker.ts`, and the
heavy archive reads in a pool of `src/read-worker.ts` threads.
Economics vectors are cached in memory. `PRAGMA data_version` detects writes by
other connections; the server serves the previous model while rebuilding and
then emits `archive_updated` so clients can refresh.

The Tools page summary and tool usage table read every matching tool call.
`src/read-cache.ts` keeps up to 32 of those results per connection, keyed by
the SQL and its parameters. A change in `data_version`, `total_changes()`, or
`schema_version` clears them, so the first read after any write recomputes.
The Analytics aggregates use the same cache: totals, every `by-dimension`
grouping, hour and weekday activity (keyed by the server's UTC offset too, since
a daylight-saving change moves local-time buckets without a write), model
sparklines, MCP usage, file hotspots, date bounds, and the source list. Each
returns a copy, so a caller that sorts or edits its result cannot change the
cached value. The cache belongs to a connection, so each read worker keeps its
own.

`src/server/read-ops.ts` names every read heavy enough to delay other
requests: session lists and transcripts, search, the search index, projects,
the Analytics and Tools aggregates, and reports. `src/server/read-pool.ts`
runs them on two long-lived workers, each with its own read-only connection,
so a slow aggregate no longer queues fast requests behind it on the server's
connection. That connection still serves the cheap routes and every write.
Each worker runs one read at a time, and the rest wait in a FIFO queue of at
most 256. A read goes to the worker its operation and arguments hash to when
that worker is free, keeping that worker's cache warm, and otherwise to
whichever worker frees up first. A read whose client disconnects while it
waits leaves the queue without running, so a dashboard filter change does not
leave stale reads ahead of the new ones. A full queue answers `503
server_busy`, which the UI retries. A worker serializes its JSON before
replying, so the request thread receives one string. Without a pool, as in tests that call `handleRequest` directly, the
same operations run inline. A read-only connection cannot reload planner
statistics with `ANALYZE sqlite_schema`, so after a sync that ingested
sessions, and when a running sync stores new statistics, each worker reopens
its connection once no read is using it.

Search filters and ranks every full-text match before keeping a page, so it
reaches each match's session through `idx_block_id_session` instead of the
block row, which holds transcript text. Messages and snippets are read for the
page's rows only.

The worker files are also standalone-binary entrypoints and must remain in the
compile entrypoint list in `scripts/distribution.ts`.

## Local API and UI

The UI, JSON routes, reports, and event stream are served by the same process.
[OpenAPI](api/openapi.yaml) is the reference contract, and the running binary
exposes that contract at `/api/openapi.json`. Operational behavior that does
not fit the schema lives in [Local Serve API](api/routes.md).

The default loopback listener is unauthenticated. A broad bind must pass the
trusted-peer source-address guard; `Host` and browser-origin checks are defense
in depth, not credentials. The app never adds an outbound runtime dependency.
The opt-in release check and the downloads `decant update` makes when you run
it, both in `src/update.ts`, are the only outbound requests. Neither sends
archive data.

Dashboard requests publish their results independently, so available data can
render while another slice is still loading. Tools aggregates scan a covering
index of call metadata rather than reading tool inputs and output previews.
The call browser selects its page of IDs before fetching transcript payloads,
keeping page reads bounded even when individual inputs are large.

## Change map

- New source format: parser, synthetic fixtures, ingest tests, and goldens.
- New schema state: a new migration plus schema and migration tests; never edit
  a committed migration.
- New serve behavior: implementation, OpenAPI, route documentation, and
  contract tests together.
- New aggregate: preserve archive-state, date, project, and tool scope across
  the CLI, API, UI, and report consumers.
- New distribution runtime module: update compile entrypoints and exercise the
  installed artifact through its real behavior.

Run `just check` before considering any of these changes ready.
