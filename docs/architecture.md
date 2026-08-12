# Architecture

Decant is one local Bun and TypeScript application. The CLI process discovers
coding-agent logs, normalizes and enriches them, owns the SQLite archive, and
optionally serves the React UI and local API. There is no daemon, hosted
service, bearer token, or second application process.

## Data flow

```text
~/.claude + ~/.codex
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
| Composition | `src/cli.ts`, `src/config.ts` | Commands, global flags, output policy, configuration, and process lifecycle. |
| Sources | `src/sources/`, `src/model.ts` | Pure, print-free parsers and the normalized wire model. |
| Ingest | `src/ingest.ts`, `src/enrich.ts`, `src/diagnostics.ts` | Discovery, change detection, normalization writes, derived facets, and ingest issues. |
| Economics | `src/cost.ts`, `src/buckets.ts`, `src/token-economics.ts`, `src/context-window.ts` | Pricing, activity attribution, persisted vectors, and occupancy timelines. |
| Storage | `src/db.ts`, `src/schema.sql`, `src/schema-manifest.ts` | SQLite ownership, WAL, migrations, permissions, and schema-drift detection. |
| Reads | `src/query.ts`, `src/stats.ts`, `src/recommendations.ts`, `src/distill.ts` | Session retrieval, aggregates, recommendations, and deterministic artifacts. |
| Serve | `src/server.ts`, `src/watch.ts`, `src/*-worker.ts` | HTTP routing, trusted peers, sync coordination, SSE, and background worker execution. |
| Presentation | `src/ui/`, `src/report/` | The local React application and self-contained HTML reports. |

Core modules return data or structured failures. Human-readable output and exit
codes belong in `src/cli.ts`; HTTP status and error-envelope policy belong in
`src/server.ts`.

## Parsing and ingest

Each source file produces one normalized session. Parsers retain canonical raw
records while mapping provider-specific roles, blocks, usage, tool calls, and
lineage into shared tables. Malformed lines and unknown record types become
diagnostics rather than aborting the file.

Ingest uses file metadata and hashes to avoid unnecessary work. A changed
session is replaced transactionally, then Decant materializes context-window
rollups and versioned per-session economics vectors. Costs are also stored at
ingest, so later pricing edits do not mutate history.

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

## Serve, workers, and caches

`decant serve` binds the HTTP listener before opening the archive. This makes a
second server fail with a truthful port-in-use message instead of first
becoming another database owner.

The server keeps request handling responsive by running source syncs in
`src/sync-worker.ts` and economics-vector scans in `src/stats-worker.ts`.
Economics vectors are cached in memory. `PRAGMA data_version` detects writes by
other connections; the server serves the previous model while rebuilding and
then emits `archive_updated` so clients can refresh.

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
