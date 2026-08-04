# AGENTS.md

Guidance for AI coding agents and humans working in this repo. Keep changes
small, tested, and consistent with the patterns already here. `CLAUDE.md` is a
symlink to this file; tool-specific files should stay thin and defer here.

## What this is

**decant** extracts Claude Code (`~/.claude/projects/*.jsonl`) and Codex
(`~/.codex/sessions/rollout-*.jsonl`) CLI sessions into a normalized,
full-text-searchable SQLite archive (WAL + FTS5).

The repo is now a single Bun + TypeScript app. The same `decant` CLI owns
parsing, ingest, reads, distillation, recommendations, watch mode, and the local
React web UI served by `decant serve`. There is no Rust daemon, Phoenix app,
Swift menu bar app, bearer token, hosted service, or separate API process on
mainline. The local serve API is documented with OpenAPI but remains part of the
one Decant process. The pre-cutover tree is preserved in the signed
`pre-typescript` tag.

## Layout

Start from `src/cli.ts`; parsers live in `src/sources/` (the extension
point). Docs: `docs/api/openapi.yaml` (local API contract),
`docs/api/routes.md` (serve semantics), `docs/distribution.md`
(npm/installer/Docker/source), and `docs/releasing.md` (release operations).

Agent tooling lives in `.claude/`. Two skills cover the work most likely to go
wrong, `new-source-parser` for invariant 6 and `new-migration` for invariant 5.
The `new-source-parser` skill stays thin and defers to
`docs/prompts/add-source.md`, the canonical add-a-source workflow that
`CONTRIBUTING.md` also points at.
`scripts/claude-hooks/reflect-on-stop.sh` is a Stop hook, wired in
`.claude/settings.json`, that nudges toward recording durable findings when a
session changed several files and wrote none down. It is offline, bash and jq
only, and always exits 0.

## Setup

- Bun 1.3+ (`bun run dev` performs a frozen install before serving).
- Docker only if you are validating the container image.
- No Rust, Elixir, Erlang, or Swift toolchain is required for mainline work.

## Commands

Run from the repo root.

- `bun run dev` — one-command local UI + startup sync.
- `just check` — the full local quality gate (see Definition of done).
- `bun run src/cli.ts --help` — the `decant` CLI: `sync`, `ls`, `search`,
  `stats`, `files`, `distill`, `recommendations`, `watch`, `serve` (the default
  when `decant` runs bare); add `--db` to target an alternate archive. `just`
  lists wrapper recipes for the common ones.

## Config

- Archive DB: `~/.decant/decant.db`, override with `DECANT_DB` or `--db`.
- Source dirs: `DECANT_CLAUDE_DIR`, `DECANT_CODEX_DIR`, or command flags.
- Settings dir: `DECANT_CONFIG_DIR`; settings default to
  `~/.config/decant/settings.json`.
- Operational logs: JSON Lines on stderr at `info` by default; override with
  `DECANT_LOG_LEVEL` (`trace` through `fatal`, or `off`). See
  `docs/logging.md`.
- `serve` binds `127.0.0.1:3000` by default; override with `--host`/`--port`.
- Trusted peers for a non-loopback `serve` resolve by precedence, not union:
  `serve --trusted-peer <ip|cidr>` (repeatable or comma-separated), then
  `DECANT_TRUSTED_PEERS` (comma-separated), then
  `DECANT_TRUST_DEFAULT_GATEWAY=1`. The first source that is present wins
  outright and replaces the ones below it, so `DECANT_TRUSTED_PEERS=` means
  "trust nobody", not "fall through". See `resolveTrustedPeers` in
  `src/server.ts`.
- `DECANT_SKILLS_DIR`: working directory the UI's "open in agent" launcher
  `cd`s into (macOS only, the only platform `canLaunch` accepts); defaults to
  `$HOME`.
- `DECANT_NO_SYNC` (any value) or `--no-sync`: skip the sync-on-read that read
  commands otherwise perform, and run `serve` without its source watcher, so it
  serves the archive as-is and ingests nothing. `POST /api/sync` still works:
  this suppresses syncs decant starts on its own, not one an operator asks for.
  Use it whenever pointing a command at a scratch archive, or the watcher will
  fill that archive from the real `~/.claude` and `~/.codex`.
- `DECANT_NO_OPEN` (any value) or `serve --no-open`: never auto-open a browser.
  `BROWSER` overrides the opener (`open`/`xdg-open`); `BROWSER=none` disables.
  Auto-open is skipped in CI and non-TTY runs; the URL banner still prints
  unless `-q`.
- Global flags on every command: `--db`, `--json`, `--format table|json|md`,
  `-q/--quiet`, `--no-color`, `--no-sync`.

## Definition of done

A change is ready when:

- `bun test` passes.
- `bunx tsc --noEmit` passes.
- `bunx biome check .` passes.
- `just check` wraps all three plus the distribution staging smoke; CI
  additionally builds the binary matrix, npm staging, and Docker images on
  every push, not only for distribution changes. The staging smoke packs and
  installs both launcher packages with `npm`, so `just check` needs network
  access even though the app itself never makes one.
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
   and no LLM calls. The only networking is the local UI/API served by
   `decant serve`, bound to loopback by default; non-loopback exposure requires
   an explicit host bind and trusted-peer configuration.
4. **Costs are computed at ingest** with `cost::estimateCost` and stored on the
   session row. Editing pricing does not rewrite historical rows; rebuild the
   archive to recompute.
5. **The schema baseline is v22.** Pre-v8 archives are intentionally rebuild-only:
   delete the archive and re-ingest from the source directories. Do not add
   broad forward migrations unless that product decision changes; the narrow
   v8-to-v22 migrations preserve existing TypeScript-cutover archives.
   `ingest_source.ingest_revision` is the parser/enrichment checkpoint: bump
   `INGEST_PIPELINE_REVISION` whenever unchanged sources must be re-derived so
   the next sync backfills them once and later syncs remain idempotent. A
   migration is frozen as soon as it is committed to a branch because a
   dogfooding archive may already have run it. During review, put any schema
   adjustment in a new version; never edit a committed migration.
6. **Parsers are the extension point.** A new source tool means
   `src/sources/<tool>.ts`, synthetic fixtures, parser tests, ingest/query tests,
   and golden updates.
7. **Serve routes are a documented local API.** `docs/api/openapi.yaml` is the
   reference contract and `/api/openapi.json` is its runtime representation.
   Keep the spec, route behavior, and contract tests in sync. This remains a
   local-first API inside the one Decant process, not a hosted service, daemon,
   bearer-token boundary, or separate cross-process server.

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

## Shared knowledge (Dosu)

Maintainers keep durable, cross-session context for this repo in a Dosu
knowledge library, reachable over the Dosu MCP server. The wiring is
per-developer and machine-local, and it carries an API key, so it must never
reach a commit.

Scope the server to this project, so a decant session cannot read or write
another library's knowledge. From the repo root:

```sh
dosu deployments switch <id>
dosu mcp add claude
```

`dosu setup --deployment <id>` is the wrong tool for that: it installs at your
agent's user scope, which makes the server global to every project on the
machine. `dosu mcp add` is the project-scoped path, but note that it writes
the key into `.mcp.json` in your working tree rather than to a config outside
the repo. `.gitignore` covers that path; do not force-add it.

Only that generated `.mcp.json` is per-project. `dosu deployments switch` sets
the CLI's own active deployment globally, so `dosu ask` run from another
checkout follows whichever deployment you switched to last, not that
checkout's `.mcp.json`.

None of this is required to build, test, or ship Decant. Without Dosu access
the tools are simply not listed and the guidance below no-ops. It is also
agent-side tooling only, never a runtime dependency of the app, so invariant 3
above still holds.

The marked region below is generated by `dosu setup`. Edit the surrounding
prose, not the block.

<!-- dosu:mcp:start v2 -->
The team you are assisting maintains shared knowledge in Dosu: consult it to build on prior work, and contribute durable knowledge so future teammates and agents do not have to rediscover it. Always use only tools currently listed by the server.

When `read_knowledge` is listed, call it before non-trivial code or documentation work involving architecture, conventions, prior decisions, gotchas, incidents, ownership, or branch history. **If unsure whether relevant context exists, read first.** Pass `repo` and `branch` when available. Skip generic questions, trivial or self-contained edits, and context already injected by Dosu. Treat results as leads and verify them against current code and state.

When `write_knowledge` is listed, use it after the task for durable, non-obvious knowledge that future work would otherwise have to rediscover. Do not save task or PR summaries, progress, test results, obvious facts, speculation, duplicates, or sensitive data. **If nothing durable was learned, do not write.**

Use `review_knowledge` only when the user asks to inspect or manage pending knowledge. Preview one item at a time and require explicit confirmation before making changes.
<!-- dosu:mcp:end -->

## When stuck

If tests fail in a way you cannot resolve, the plan looks wrong, or a change
would alter the archive schema/route semantics, stop and report the exact
failure output before guessing.
