# decant

[![CI](https://github.com/dosu-ai/decant/actions/workflows/ci.yml/badge.svg)](https://github.com/dosu-ai/decant/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

decant turns your local Claude Code and Codex CLI session logs into a
searchable, analyzable SQLite archive — with a CLI and a local web UI, and
nothing ever leaves your machine.

![decant serve UI showing the session archive with synthetic demo data](docs/assets/decant-serve.png)

## What and Why

decant reads the JSONL logs Claude Code and Codex already write
(`~/.claude/projects/*.jsonl`, `~/.codex/sessions/rollout-*.jsonl`), normalizes
both formats into one WAL + FTS5 SQLite archive, and keeps everything local.
Browse, search, and analyze that history from a fast local CLI or the bundled
web UI (`decant serve`). Use it to:

- **Find that command from last week** — full-text search across every
  message and tool call, from the CLI or the UI's search page.
- **See where token spend goes** — cost, tool, MCP, file-hotspot, and
  activity analytics broken down by model, project, or day.
- **Turn a repeated workflow into a script** — `decant distill` generates a
  runnable shell/just/make script, a faithful session replay, or a
  SKILL.md/AGENTS.md snippet straight from your real command history.

## Requirements

Bun 1.3+ — only if you're building or running from source. The npm,
`curl | sh`, and Docker installs need nothing but Node, `curl`, and Docker
respectively.

## Quick Start

Run from source — this works today, before any package or image is published:

```bash
bun run dev
```

`bun run dev` installs dependencies with the lockfile frozen, starts `decant
serve`, runs the startup sync, and keeps watching your source logs. Open
`http://127.0.0.1:3000`.

**Available from v0.1.0**, once the Release workflow has published a version:

```bash
npx @dosu/decant serve
```

```bash
curl -fsSL https://raw.githubusercontent.com/dosu-ai/decant/main/install.sh | sh
decant serve
```

```bash
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -v decant-data:/var/lib/decant \
  -v "$HOME/.claude/projects:/sources/claude:ro" \
  -v "$HOME/.codex:/sources/codex:ro" \
  ghcr.io/dosu-ai/decant:latest
```

See [Install Matrix](#install-matrix) below for the full set of options, and
[docs/distribution.md](docs/distribution.md) for the detail behind each one.

## CLI

```bash
decant sync
decant ls
decant show 1
decant search "auth bug"
decant stats --by model
decant tokens
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

All read commands support `--json` (`--format json` is equivalent; `--format
md` is also available). Use `--db /path/to/decant.db` or `DECANT_DB` for an
alternate archive. Every command also accepts `-q`/`--quiet`, `--no-color`,
and `--no-sync` (skip the sync-on-read that read commands otherwise perform).
Use `decant sync --path /path/to/log-or-dir` to ingest only specific source
files or a temporary source tree, including raw Claude `stream-json` logs;
pass `--path` more than once to ingest multiple paths.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `DECANT_DB` | Archive path | `~/.decant/decant.db` |
| `DECANT_CLAUDE_DIR` | Claude projects directory | `~/.claude/projects` |
| `DECANT_CODEX_DIR` | Codex home directory | `~/.codex` |
| `DECANT_CONFIG_DIR` | Settings directory | `~/.config/decant` |
| `DECANT_TRUSTED_PEERS` | Comma-separated peer IPs/IPv4 CIDRs allowed through the local API guard when `serve` is bound to a non-loopback host; unions with repeatable `serve --trusted-peer <cidr>` flags | unset |
| `DECANT_SKILLS_DIR` | Working directory the UI's "open in agent" launcher `cd`s into (macOS only) | `$HOME` |
| `DECANT_NO_SYNC` | Set to any value to skip sync-on-read for read commands (same as `--no-sync`) | unset |

`decant serve` binds `127.0.0.1:3000` by default. Override with
`--host`/`--port`.

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
tag. Route reference for the local UI lives in
[docs/api/routes.md](docs/api/routes.md).

## Install Matrix

Ordered from the most streamlined to the most manual. Everything except
"Build from source" is **available from v0.1.0**, once the Release workflow
has published a version. See [docs/distribution.md](docs/distribution.md)
for build details and release verification, including the full explanation
behind the Docker command below.

1. **npx / npm** — zero persistent install, or a global one:

   ```bash
   npx @dosu/decant sync
   npm i -g @dosu/decant   # persistent install
   ```

2. **Install script** — for machines without Node:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/dosu-ai/decant/main/install.sh | sh
   ```

   Detects your platform, downloads the matching release tarball, verifies it
   against `SHA256SUMS`, and installs to `${DECANT_INSTALL_DIR:-~/.local/bin}`.
   Pin a version with `DECANT_VERSION`, skip the `PATH` edit with
   `DECANT_NO_MODIFY_PATH=1`, or point `DECANT_BASE_URL` at a mirror — see
   [docs/distribution.md](docs/distribution.md) for the full knob list.

3. **Docker**:

   ```bash
   docker run --rm \
     -p 127.0.0.1:3000:3000 \
     -v decant-data:/var/lib/decant \
     -v "$HOME/.claude/projects:/sources/claude:ro" \
     -v "$HOME/.codex:/sources/codex:ro" \
     ghcr.io/dosu-ai/decant:latest
   ```

   Keep the `127.0.0.1:` host prefix on the port publish — see
   [docs/distribution.md](docs/distribution.md#docker) for why, and for how
   the container's trusted-peer allowlist works.

4. **Build from source** — the contributor path, and the only one that works
   today:

   ```bash
   bun run dev
   ```

> `brew install dosu-ai/dosu/decant` also works, as an optional one-liner via
> the community tap (it auto-taps in one command; no separate `brew tap`
> step). It's a convenience, not a requirement — nothing above depends on
> Homebrew. Details in [docs/distribution.md](docs/distribution.md).

## Upgrading and Troubleshooting

- **Schema rebuilds.** Archives older than schema v8 are rebuild-only. v8 and
  v9 archives migrate to v10 on open; the next `decant sync` backfills
  persisted economics vectors for unchanged sessions. If `decant` refuses to
  open an old archive, delete it and re-run `decant sync` — source logs remain
  the source of truth, so nothing is lost.
- **Upgrading.** `npx @dosu/decant@latest` always resolves the newest
  published version. For a persistent install, run `npm i -g
  @dosu/decant@latest`, re-run the install script, or `docker pull
  ghcr.io/dosu-ai/decant:latest`.
- **`decant --version` prints `0.0.0-dev`.** Expected for an unstamped build —
  anything built from source, or by CI without an explicit version, reports
  this. Released binaries and packages carry a real version.
- **Docker API requests come back `403`.** See
  [docs/distribution.md](docs/distribution.md#docker) — the container's
  trusted-peer allowlist unions the image's baked-in default with any
  `--trusted-peer` flags you add; to narrow it, override the
  `DECANT_TRUSTED_PEERS` environment variable itself rather than adding a
  flag.

## Contributing, Security, and License

- Contributing guide: [CONTRIBUTING.md](CONTRIBUTING.md). Full command
  reference and project invariants: [AGENTS.md](AGENTS.md).
- Security policy and vulnerability reporting: [SECURITY.md](SECURITY.md).
- Licensed under the [Apache License 2.0](LICENSE).
