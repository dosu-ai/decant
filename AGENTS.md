# AGENTS.md

Guidance for AI coding agents and humans working in this repo. Keep changes
small, tested, and consistent with the patterns already here. `CLAUDE.md` is a
symlink to this file; tool-specific files should stay thin and defer here.

## What this is

**decant** extracts Claude Code (`~/.claude/projects/*.jsonl`), Codex
(`~/.codex/sessions/rollout-*.jsonl`), and Cursor Agent JSONL sessions into a
normalized, full-text-searchable SQLite archive (WAL + FTS5). Cursor staged
`stream-json` imports are configured explicitly; native discovery reads
`~/.cursor/projects/*/agent-transcripts` plus `~/.cursor/chats/*/*/meta.json`
when the experimental settings preview is enabled.

The repo is now a single Bun + TypeScript app. The same `decant` CLI owns
parsing, ingest, reads, distillation, recommendations, watch mode, and the local
React web UI served by `decant serve`. There is no Rust daemon, Phoenix app,
Swift menu bar app, bearer token, or cross-process OpenAPI contract on mainline.
The pre-cutover tree is preserved in the signed `pre-typescript` tag.

## Layout

| Path | Responsibility |
|---|---|
| `src/cli.ts` | Commander CLI entrypoint and all stdout/stderr/exit-code policy. |
| `src/db.ts`, `src/schema.sql` | SQLite opener and frozen v9 baseline schema. |
| `src/sources/` | Per-tool parsers: `claude.ts`, `codex.ts`, `cursor.ts`. |
| `src/ingest.ts` | Idempotent sync from source logs into the archive. |
| `src/query.ts`, `src/stats.ts`, `src/export.ts` | Read/query/render surfaces. |
| `src/distill.ts`, `src/recommendations.ts` | Deterministic artifact and recommendation generation. |
| `src/watch.ts`, `src/server.ts` | Watch loop, local JSON routes, SSE, and UI serving. |
| `src/ui/` | React UI bundled by Bun HTML imports. |
| `src/settings.ts`, `src/launcher.ts` | Local settings and native launcher helpers. |
| `fixtures/` | Tiny synthetic Claude/Codex/Cursor session files. |
| `test/golden/` | Static golden snapshots frozen from the pre-TypeScript implementation. |
| `npm/` | Publishable npm launcher package plus platform binary package manifests. |
| `scripts/` | Distribution build/staging helpers. |
| `docs/api/routes.md` | Local `decant serve` route reference. |
| `docs/distribution.md` | npm, Docker, and source distribution notes. |
| `docs/superpowers/` | Historical specs and implementation plans. |

## Setup

- Bun 1.3+ (`bun run dev` performs a frozen install before serving).
- Docker only if you are validating the container image.
- No Rust, Elixir, Erlang, or Swift toolchain is required for mainline work.

## Commands

Run from the repo root.

```sh
# One-command local UI + filesystem watch
bun run dev

# Quality gates
bun test
bunx tsc --noEmit
bunx biome check .
just check

# CLI
bun run src/cli.ts sync
bun run src/cli.ts ls
bun run src/cli.ts search "auth bug"
bun run src/cli.ts stats --by model
bun run src/cli.ts files --group ext
bun run src/cli.ts distill script
bun run src/cli.ts recommendations ls
bun run src/cli.ts --db /tmp/decant.db ls

# Long-running local modes
bun run src/cli.ts watch
bun run src/cli.ts serve

# Distribution
bun run scripts/build-binaries.ts --target native
bun run scripts/build-npm.ts --target native --no-build
docker build --platform linux/amd64 -t decant:local .
```

Config:

- Archive DB: `~/.decant/decant.db`, override with `DECANT_DB` or `--db`.
- Source dirs: `DECANT_CLAUDE_DIR`, `DECANT_CODEX_DIR`, `DECANT_CURSOR_DIR`,
  `DECANT_CURSOR_CHATS_DIR`, or command flags.
- Settings dir: `DECANT_CONFIG_DIR`; settings default to
  `~/.config/decant/settings.json`.
- `serve` binds `127.0.0.1:3000` by default; override with `--host`/`--port`.

## Definition of done

A change is ready when:

- `bun test` passes.
- `bunx tsc --noEmit` passes.
- `bunx biome check .` passes.
- New behavior has focused tests. Do not weaken or delete tests to make them pass.
- Distribution changes also get a native binary smoke test and, when Docker is
  touched, a local `docker build`/`docker run --help` smoke if Docker is available.

## Project invariants

1. **Core modules stay print-free.** Parsing, ingest, query, stats, distill,
   recommendations, and DB helpers return data and `Result`-style errors. CLI
   output and exit-code policy belongs in `src/cli.ts`.
2. **One process owns SQLite.** The CLI process opens the archive directly. WAL
   mode stays enabled so reads and ingest can coexist. Do not reintroduce a
   background daemon, token/lock file, or second app that opens the DB behind a
   separate contract.
3. **Local-first only.** No outbound network calls, no hosted service dependency,
   and no LLM calls. The only networking is the loopback UI/API served by
   `decant serve`.
4. **Costs are computed at ingest** with `cost::estimateCost` and stored on the
   session row. Editing pricing does not rewrite historical rows; rebuild the
   archive to recompute.
5. **The schema baseline is v9.** Pre-v8 archives are intentionally rebuild-only:
   delete the archive and re-ingest from the source directories. Do not add
   broad forward migrations unless that product decision changes; the narrow
   v8-to-v9 migration preserves existing TypeScript-cutover archives.
6. **Parsers are the extension point.** A new source tool means
   `src/sources/<tool>.ts`, synthetic fixtures, parser tests, ingest/query tests,
   and golden updates. Cursor is the current third parser; keep its native
   preview gated unless the transcript format is promoted to stable.
7. **Serve routes are internal app routes.** `docs/api/routes.md` is a reference,
   not a versioned public contract.

## Security and data privacy

- Never commit secrets, API keys, tokens, `.env`, private keys, real transcripts,
  or a personal archive DB.
- `~/.claude` and `~/.codex` contain private transcripts. Fixtures must stay
  synthetic; `test/golden/` must stay generated from synthetic fixtures only.
- Do not add remote network calls. Docker and npm install paths may fetch
  dependencies at install/build time, but the app itself remains offline.

## Conventions

- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`,
  scope optional). Sign commits when the environment supports it.
- Prefer surrounding code style, narrow changes, and focused tests.
- Branch off `main`; open a PR. CI must be green.
- Install hooks once with `pre-commit install` if you use pre-commit locally.

## When stuck

If tests fail in a way you cannot resolve, the plan looks wrong, or a change
would alter the archive schema/route semantics, stop and report the exact
failure output before guessing.
