# decant

[![CI](https://github.com/dosu-ai/decant/actions/workflows/ci.yml/badge.svg)](https://github.com/dosu-ai/decant/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Extract Claude Code and Codex CLI sessions into a normalized,
full-text-searchable SQLite archive, then browse, search, analyze, and distill
that history from a fast local CLI or web UI.

decant reads the JSONL logs those tools already write
(`~/.claude/projects/*.jsonl`, `~/.codex/sessions/rollout-*.jsonl`), normalizes
the formats into one WAL + FTS5 SQLite archive, and keeps everything local. Your
transcripts never leave your machine.

## Features

- One archive for Claude Code and Codex sessions.
- Full-text search across messages and tool calls.
- Usage, cost, tool, MCP, file-hotspot, and activity analytics.
- Deterministic `distill` artifacts from real command history: scripts, replays,
  and skill/AGENTS snippets.
- Persisted recommendations with implemented-state tracking.
- Local React UI served by the same Bun process: `decant serve`.
- Watch mode with native filesystem events plus a periodic sweep.
- Scriptable JSON output, shell completions, and stable exit codes.

## Quick Start

Use source during the pre-release TypeScript migration:

```bash
bun run dev
```

Requires Bun 1.3+. `bun run dev` installs dependencies with the lockfile
frozen, starts `decant serve`, runs the startup sync, and keeps watching your
source logs. The UI runs at `http://127.0.0.1:3000`.

After the first Release workflow publishes packages, install from npm without
installing Bun:

```bash
npx @dosu/decant sync
npx @dosu/decant ls
npx @dosu/decant search "auth bug"
npx @dosu/decant serve
```

After the first Release workflow publishes an image, run the GHCR image:

```bash
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -v decant-data:/var/lib/decant \
  -v "$HOME/.claude/projects:/sources/claude:ro" \
  -v "$HOME/.codex:/sources/codex:ro" \
  ghcr.io/dosu-ai/decant:latest
```

Keep the `127.0.0.1:` host prefix on the Docker port publish. Publishing as
`-p 3000:3000` exposes the archive port on every host interface. The container
binds `0.0.0.0` only inside its own network namespace so Docker's host loopback
publish can reach it. The image trusts Docker bridge peers by default via
`DECANT_TRUSTED_PEERS=172.16.0.0/12`; use a narrower value if your local Docker
network is different.

## CLI

```bash
decant sync
decant ls
decant show 1
decant search "auth bug"
decant stats --by model
decant files --group ext
decant tool stats
decant mcp stats
decant distill script
decant distill replay 1
decant distill skill --kind agents
decant recommendations ls
decant export 1 > session.md
decant completion zsh
```

All read commands support `--json`. Use `--db /path/to/decant.db` or
`DECANT_DB` for an alternate archive. Use `decant sync --path /path/to/log-or-dir`
to ingest only specific source files or a temporary source tree, including raw
Claude `stream-json` logs; pass `--path` more than once to ingest multiple paths.

## Configuration

- `DECANT_DB`: archive path, default `~/.decant/decant.db`.
- `DECANT_CLAUDE_DIR`: Claude projects directory, default
  `~/.claude/projects`.
- `DECANT_CODEX_DIR`: Codex home directory, default `~/.codex`.
- `DECANT_CONFIG_DIR`: settings directory, default `~/.config/decant`.
- `DECANT_TRUSTED_PEERS`: comma-separated peer IPs or IPv4 CIDRs allowed through
  the local API guard when `serve` is bound to a non-loopback host.

`decant serve` binds `127.0.0.1:3000` by default. Override with
`--host`/`--port`.

Archives older than schema v8 are rebuild-only. v8 and v9 archives migrate to
v10 on open; the next `decant sync` backfills persisted economics vectors for
unchanged sessions. Older archives should be deleted and rebuilt with
`decant sync`. Source logs remain the source of truth.

## How It Works

```
~/.claude + ~/.codex
        |
        v
 Bun + TypeScript decant process
 parse -> enrich -> ingest + economics vectors -> SQLite WAL + FTS5
        |
        +--> CLI reads / JSON
        +--> local React UI + JSON routes + SSE
```

There is no background daemon and no cross-process API contract. The old
Rust/Phoenix/Swift implementation is preserved in the signed `pre-typescript`
tag.

Route reference for the local UI lives in [docs/api/routes.md](docs/api/routes.md).
Distribution notes live in [docs/distribution.md](docs/distribution.md).
Release automation is configured to publish npm packages and the GHCR image from
the `Release` workflow once a version is dispatched.

## Development

Run the local UI and watcher:

```bash
bun run dev
```

Run quality gates:

```bash
bun test
bunx tsc --noEmit
bunx biome check .
just check
```

Build distribution artifacts:

```bash
bun run scripts/build-binaries.ts --target native
bun run scripts/build-npm.ts --target native --no-build
docker build --platform linux/amd64 -t decant:local .
```

See [AGENTS.md](AGENTS.md) for the full command list, conventions, and project
invariants.

## Security and Privacy

decant is local-first and offline at runtime. It reads files already on disk and
makes no outbound runtime network calls. Do not commit real session data,
personal archives, tokens, keys, or `.env` files. To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
