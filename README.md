# decant

[![CI](https://github.com/dosu-ai/decant/actions/workflows/ci.yml/badge.svg)](https://github.com/dosu-ai/decant/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/dosu-ai/decant/badge)](https://scorecard.dev/viewer/?uri=github.com/dosu-ai/decant)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Your coding agent sessions contain a lot of useful information. What tokens got
spent on, how full the context window got, which files an agent worked with, and
what a run cost. decant gives you insight into what's on disk, right now.

It reads the JSONL logs Claude Code and Codex already write
(`~/.claude/projects/*.jsonl`, `~/.codex/sessions/rollout-*.jsonl`), normalizes
both formats into one WAL + FTS5 SQLite archive, and gives you full-text search,
token economics, context-window occupancy, and phase breakdowns from a CLI or a
local web UI. Your transcripts never leave your machine.

![decant serve showing the analytics view: session, message, tool-call, token,
and cost totals; an activity breakdown splitting cost and time across context,
planning, code, and communicating; and sessions-per-day and cost-per-day charts.
Rendered from synthetic demo data.](docs/assets/decant-serve.png)

## Features

- One archive for Claude Code and Codex sessions.
- Full-text search across messages and tool calls.
- Usage, [estimated cost](docs/pricing.md), tool, MCP, file-hotspot, and
  activity analytics.
- Deterministic `distill` artifacts from real command history: scripts, replays,
  and skill/AGENTS snippets.
- Persisted recommendations with implemented-state tracking.
- Local React UI served by the same Bun process: `decant serve`.
- Watch mode with native filesystem events plus a periodic sweep.
- Scriptable JSON output, shell completions, and stable exit codes.

## Quick Start

Run from source. This works today, before any package or image is published:

```bash
bun run dev
```

Requires Bun 1.3+. `bun run dev` performs a frozen dependency install, starts
`decant serve`, runs the startup sync, and keeps watching your source logs. The
UI runs at `http://127.0.0.1:3000`.

Everything below is **available from v0.1.0**, once the Release workflow has
published a version. See [Install Matrix](#install-matrix) for the full set of
options and when to pick which.

Run it with npm, no Bun install needed:

```bash
npx @dosu/decant sync
npx @dosu/decant ls
npx @dosu/decant search "auth bug"
npx @dosu/decant serve
```

Install it with Homebrew:

```bash
brew tap dosu-ai/dosu && brew install decant
decant serve
```

Install it without Node, straight from the release assets:

```bash
curl -fsSL https://raw.githubusercontent.com/dosu-ai/decant/main/install.sh | sh
decant serve
```

Run the GHCR image:

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
publish can reach it.

The API is unauthenticated, so the peer's source address is the boundary. The
image ships no peer allowlist. It sets `DECANT_TRUST_DEFAULT_GATEWAY=1`, which
trusts exactly one address: the container's own bridge gateway, which is where
Docker's port publisher forwards `-p` traffic from. It does that only when
decant can prove the default route is a container veth to an on-link gateway
inside `172.16.0.0/12`. A sibling container on the same bridge keeps its own
source address and gets `403 forbidden remote`.

Shapes that cannot be proven trust nobody beyond loopback and need one env var:
`--network host`, macvlan/ipvlan, multi-homed hosts, and bridges outside
`172.16.0.0/12` (Podman's `10.88.0.0/16`, a custom `--subnet`, Kubernetes). If
the UI answers `403 forbidden remote`, set `DECANT_TRUSTED_PEERS` to the exact
address requests arrive from, for example
`-e DECANT_TRUSTED_PEERS=192.168.65.1`. That replaces the gateway default
entirely; `DECANT_TRUST_DEFAULT_GATEWAY=0` turns it off without naming a peer.

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
decant export 1 --as trajectory > session.trajectory.json
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
- `DECANT_LOG_LEVEL`: minimum structured operational log level written as JSON
  Lines to stderr. Defaults to `info`; accepts `trace`, `debug`, `info`, `warn`
  (or `warning`), `error`, `fatal`, and `off` (or `silent`).
- `DECANT_NO_SYNC`: set to any value to skip the sync-on-read that read commands
  perform, and to run `decant serve` without its source watcher so it serves the
  archive as-is and ingests nothing. The `--no-sync` flag does the same. The
  "Sync now" button and `POST /api/sync` still work; this only suppresses the
  syncing decant starts on its own.
- `DECANT_TRUSTED_PEERS`: comma-separated peer IPs or IPv4 CIDRs allowed through
  the local API guard when `serve` is bound to a non-loopback host. Unset by
  default. Keep it as narrow as the deployment allows: every listed address, and
  every address inside a listed CIDR, reads and writes the whole archive without
  a credential.
- `DECANT_TRUST_DEFAULT_GATEWAY`: set to `1` to trust this container's own
  bridge gateway, resolved once at startup from `/proc/net/route` and
  `/sys/class/net`. Off by default and off for any other value, including `0`.
  The derived peer is a single address, and only when the default route is a
  container veth pointing at an on-link gateway inside `172.16.0.0/12`; every
  other shape resolves to no peers. The container image turns this on so the
  documented `docker run` recipe works without a peer CIDR.

Precedence is replace, not merge: `--trusted-peer` wins over
`DECANT_TRUSTED_PEERS`, which wins over `DECANT_TRUST_DEFAULT_GATEWAY`. Setting
either peer source, including `DECANT_TRUSTED_PEERS=` with an empty value,
means no gateway is derived.

`decant serve` binds `127.0.0.1:3000` by default. Override with
`--host`/`--port`. There is no authentication, so bind loopback unless you
deliberately want other hosts in: the `Host` header check is not an access
control for non-browser clients, which can send `Host: localhost` freely.

Archives older than schema v8 are rebuild-only. v8 through v14 archives migrate
forward to v15 on open; the next `decant sync` backfills persisted economics
vectors and context-window rollups for unchanged sessions. Older archives should
be deleted and rebuilt with `decant sync`. Source logs remain the source of
truth, so nothing is lost by rebuilding.

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
Operational log fields and privacy rules live in [docs/logging.md](docs/logging.md).
Distribution notes live in [docs/distribution.md](docs/distribution.md), and the
tag-driven release pipeline is documented in
[docs/releasing.md](docs/releasing.md).

## Install Matrix

Ordered from the most streamlined to the most manual. Everything except "build
from source" is **available from v0.1.0**, once the Release workflow has
published a version. See [docs/distribution.md](docs/distribution.md) for build
details and per-artifact verification.

1. **npx / npm** — zero persistent install, or a global one:

   ```bash
   npx @dosu/decant sync
   npm i -g @dosu/decant   # persistent install, then just `decant`
   ```

2. **Homebrew** — via the `dosu-ai/dosu` tap:

   ```bash
   brew tap dosu-ai/dosu && brew install decant
   brew install dosu-ai/dosu/decant   # equivalent one-liner
   ```

3. **Install script** — for machines without Node:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/dosu-ai/decant/main/install.sh | sh
   ```

   Detects your platform, downloads the matching release tarball, verifies it
   against `SHA256SUMS`, and installs to `${DECANT_INSTALL_DIR:-~/.local/bin}`.
   Pin a version with `DECANT_VERSION`, skip the `PATH` edit with
   `DECANT_NO_MODIFY_PATH=1`, or point `DECANT_BASE_URL` at a mirror — see
   [docs/distribution.md](docs/distribution.md) for the full knob list.

4. **Docker** — the `ghcr.io/dosu-ai/decant` image, per the `docker run` recipe
   in [Quick Start](#quick-start). Keep the `127.0.0.1:` host prefix on the port
   publish.

5. **Build from source** — the contributor path, and the only one that works
   before v0.1.0:

   ```bash
   bun run dev
   ```

**macOS, tarball downloads only.** v0.1.0 binaries are ad-hoc signed but not
notarized, so a tarball downloaded through a browser carries
`com.apple.quarantine` and Gatekeeper blocks the first run. Clear it with
`xattr -d com.apple.quarantine ./decant`. `brew install`, `npx @dosu/decant`, and the
install script are unaffected, because none of them set the quarantine
attribute. Integrity comes from SLSA build provenance, `SHA256SUMS`, and the
`gh attestation verify` check `install.sh` runs.

**Upgrading.** `npx @dosu/decant@latest` always resolves the newest published
version. For a persistent install, run `npm i -g @dosu/decant@latest`,
`brew upgrade decant`, re-run the install script, or
`docker pull ghcr.io/dosu-ai/decant:latest`. A build that reports
`0.0.0-dev` from `decant --version` is an unstamped one — anything built from
source, or by CI without an explicit version; released artifacts carry a real
version.

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
