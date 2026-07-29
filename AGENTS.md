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
Swift menu bar app, bearer token, or cross-process OpenAPI contract on mainline.
The pre-cutover tree is preserved in the signed `pre-typescript` tag.

## Layout

Start from `src/cli.ts`; parsers live in `src/sources/` (the extension
point). Docs: `docs/api/routes.md` (serve routes), `docs/distribution.md`
(npm/installer/Docker/source), and `docs/releasing.md` (release operations).

## Setup

- Bun 1.3+ (`bun run dev` performs a frozen install before serving).
- Docker only if you are validating the container image.
- No Rust, Elixir, Erlang, or Swift toolchain is required for mainline work.

## Commands

Run from the repo root.

- `bun run dev` — one-command local UI + startup sync.
- `just check` — the full local quality gate (see Definition of done).
- `bun run src/cli.ts --help` — the `decant` CLI: `sync`, `ls`, `search`,
  `stats`, `files`, `distill`, `recommendations`, `watch`, `serve`; add
  `--db` to target an alternate archive. `just` lists wrapper recipes for
  the common ones.

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
   and no LLM calls. The only networking is the loopback UI/API served by
   `decant serve`.
4. **Costs are computed at ingest** with `cost::estimateCost` and stored on the
   session row. Editing pricing does not rewrite historical rows; rebuild the
   archive to recompute.
5. **The schema baseline is v19.** Pre-v8 archives are intentionally rebuild-only:
   delete the archive and re-ingest from the source directories. Do not add
   broad forward migrations unless that product decision changes; the narrow
   v8-to-v19 migrations preserve existing TypeScript-cutover archives. A
   migration is frozen as soon as it is committed to a branch because a
   dogfooding archive may already have run it. During review, put any schema
   adjustment in a new version; never edit a committed migration.
6. **Parsers are the extension point.** A new source tool means
   `src/sources/<tool>.ts`, synthetic fixtures, parser tests, ingest/query tests,
   and golden updates.
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
