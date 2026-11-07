# Decant

[![npm version](https://img.shields.io/npm/v/%40dosu%2Fdecant?logo=npm)](https://www.npmjs.com/package/@dosu/decant)
[![npm downloads](https://img.shields.io/npm/dm/%40dosu%2Fdecant?logo=npm)](https://www.npmjs.com/package/@dosu/decant)
[![CI](https://github.com/dosu-ai/decant/actions/workflows/ci.yml/badge.svg)](https://github.com/dosu-ai/decant/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/dosu-ai/decant/badge)](https://scorecard.dev/viewer/?uri=github.com/dosu-ai/decant)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13840/badge)](https://www.bestpractices.dev/projects/13840)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Decant shows where your coding agents spend tokens, money, and time. It reads
the session logs that Claude Code, Codex, Gemini CLI, OpenCode, Cursor CLI,
GitHub Copilot CLI, and Copilot Chat in VS Code already write on your machine,
plus [ATIF](https://harborframework.com/docs/agents/atif) trajectories you
import, into one searchable archive. You explore it in a local web UI or from
the command line.

Built by
[Dosu](https://dosu.dev?utm_source=decant&utm_medium=github&utm_campaign=attribution&utm_content=readme).

https://github.com/user-attachments/assets/188f7cca-5b0a-4504-8eb2-a317a606d91e

## Quick start

```sh
npx @dosu/decant@latest
```

You don't need Bun or a global install. The command indexes the agent logs it
finds, starts the web UI at <http://127.0.0.1:3000>, and keeps watching for new
sessions. For a persistent `decant` command, see [Installation](#installation).

## Features

- One SQLite archive for every supported agent, with full-text search across
  prompts, responses, tool names, and tool inputs.
- Full transcripts for every session, with diagnostics for records Decant could
  not parse.
- Token, [estimated cost](docs/pricing.md), context-window, and agent-time
  analytics by agent, model, project, repository (including worktrees), outcome,
  and day.
- File hotspots, tool usage, and MCP server usage across sessions.
- Recommendations drawn from patterns in your sessions, each with a suggested
  change you can mark as implemented.
- Session exports to Markdown, JSON, Letta's trajectory-v1, and ATIF.
- HTML reports of the analytics view or a single session. Reports leave out
  transcript messages and tool bodies but include project paths, and a session
  report adds its title, a prompt preview, and file paths. Review a report
  before you share it.
- Workflow scripts, session replays, and agent instructions (`SKILL.md`,
  `AGENTS.md` sections, and slash commands) distilled from command history.
- A local HTTP API with an OpenAPI 3.1 contract.

## Supported agents

Decant finds each agent's logs in its default location. To point it somewhere
else, or for per-agent details, see [Sources](docs/sources.md).

| Agent | Default location | Token usage |
| --- | --- | --- |
| Claude Code | `~/.claude/projects` | Recorded |
| Codex | `~/.codex` | Recorded |
| Gemini CLI | `~/.gemini/tmp` | Recorded |
| OpenCode 1.2 and later | `~/.local/share/opencode` | Recorded |
| Cursor CLI | `~/.cursor/chats` | Not recorded by Cursor |
| GitHub Copilot CLI | `~/.copilot/session-state` | Recorded, priced at the model's API rates |
| Copilot Chat in VS Code | VS Code's `User` directory | VS Code builds from April 2026 on, as a rough estimate |
| ATIF trajectories | `~/.decant/atif` | From step `metrics` or `final_metrics` |

When an agent records no usage, Decant shows tokens and cost as unavailable
instead of $0.

## Where does my data go?

Decant is local-first. It makes no outbound network calls at runtime, and your
transcripts never leave your machine. The one exception is an update check that
stays off until you turn it on. See [Updating](#updating).

> [!IMPORTANT]
> Decant does keep a copy of your transcripts. To make sessions searchable, it
> writes prompts, tool inputs, tool output, and canonicalized raw records for
> retained transcript messages into an **unencrypted** SQLite archive at
> `~/.decant/decant.db`, with a full-text index over the prompt and
> tool-argument text. Whatever your agents read is in there too, including
> source code, file contents, local paths, and any credentials pasted into a
> session.
>
> Decant creates the archive owner-only (`0600`). If your organization has a
> retention policy for agent transcripts, the archive is subject to it. See
> [What the archive stores](docs/data-lifecycle.md#what-the-archive-stores) to
> inspect, delete, or remove it.

## Installation

> [!NOTE]
> Published binaries support macOS and Linux on x64 and arm64. Native Windows
> binaries are not currently available.

### npm

```sh
npm install --global @dosu/decant@latest
decant
```

The npm package is a small launcher that runs the matching native binary. It
needs Node.js 18 or newer, and does not need Bun.

### Homebrew

```sh
brew install dosu-ai/dosu/decant
decant
```

### Shell installer

This installs the latest release without Node.js or Bun:

```sh
curl -fsSL https://raw.githubusercontent.com/dosu-ai/decant/main/install.sh | sh
decant
```

### Docker

```sh
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -v decant-data:/var/lib/decant \
  -v "$HOME/.claude/projects:/sources/claude:ro" \
  -v "$HOME/.codex:/sources/codex:ro" \
  -v "$HOME/.gemini/tmp:/sources/gemini:ro" \
  -v "$HOME/.cursor/chats:/sources/cursor:ro" \
  -v "$HOME/.copilot/session-state:/sources/copilot:ro" \
  -v "$HOME/Library/Application Support/Code/User:/sources/vscode:ro" \
  -v "$HOME/.decant/atif:/sources/atif:ro" \
  ghcr.io/dosu-ai/decant:latest
```

The VS Code mount shows the macOS path. On Linux, mount
`$HOME/.config/Code/User` instead.

> [!WARNING]
> Keep the `127.0.0.1:` prefix. Publishing `-p 3000:3000` exposes the
> unauthenticated archive API on every host interface. Custom container
> networks may need the trusted-peer setting documented under
> [Docker distribution](docs/distribution.md#docker).

The source mounts are read-only, but `decant-data` is a named volume. The
archive outlives every container, and neither `--rm` nor `docker rm` removes
it. Run `docker volume rm decant-data` when you want it gone.

### From source

Source builds need Bun 1.3 or newer. Follow the steps under
[Contributing](#contributing).

[Distribution](docs/distribution.md) covers installer options, native builds,
and release verification.

### Updating

```sh
decant update           # install the newest release in place
decant update --check   # only report whether one exists
```

`decant update` uses the tool that installed Decant. It runs
`npm install --global` for npm and `brew update` and `brew upgrade` for
Homebrew, and makes a checksum-verified download for the shell installer.
Docker, `npx`, source checkouts, and binaries Decant did not install print how
to update instead.

To hear about new releases, turn on **Check for updates** in Settings or set
`DECANT_UPDATE_CHECK=1`. Decant then asks the npm registry for the newest
version once a day and shows a notice in the sidebar and after CLI commands.
The request carries no session data.

## Usage

### Web UI

Run `decant` with no arguments to sync your sessions, start the UI at
<http://127.0.0.1:3000>, and open it in your browser. `decant serve --no-open`
skips the browser, and `--host` and `--port` change the address.

To keep Decant running without a terminal, turn on **Run in the background** in
Settings or run `decant service install`. It then starts at login on macOS and
Linux. See [Running in the background](docs/data-lifecycle.md#running-in-the-background).

| Page | What it shows |
| --- | --- |
| Analytics | Token, cost, context, and agent-time rollups across sessions |
| Insights | Recommendations drawn from your history, and the ones you have implemented |
| Sessions | Every session, with its full transcript |
| Search | Full-text matches in prompts, responses, tool names, and tool inputs |
| Projects | Sessions and cost for each project |
| Files | The files agents read, edit, and write most |
| Tools & MCP | Tool calls and MCP server usage |

### CLI

```sh
decant                         # start the local web UI
decant sync                    # index new and changed sessions
decant ls                      # list sessions
decant show 1                  # render a transcript
decant search "auth bug"       # full-text search
decant stats --by model        # usage and cost rollups
decant economics               # token, cost, and time breakdowns
decant files --group ext       # file hotspots
decant tool stats              # tool usage
decant mcp stats               # MCP server usage
decant export 1 > session.md   # export a session
decant export 1 --as atif      # also md, json, and trajectory
decant distill script          # workflow script from command history
decant db info                 # what the archive holds and where
decant session rm 1 --yes      # delete a session and its descendants
decant db vacuum               # release the freed pages after a delete
decant db compact              # losslessly compress stored source records
decant update                  # update Decant with the tool that installed it
decant service install         # start Decant at login and keep it running
decant doctor                  # redacted environment report for bug reports
```

Run `decant --help` or `decant <command> --help` for every command and flag.
Read commands support `--json`. Global flags include `--db`, `--format`,
`--quiet`, `--no-color`, and `--no-sync`. `--db` or `DECANT_DB` sets the
archive path.

### Local API

`decant serve` also serves a local HTTP API. Its OpenAPI 3.1 contract is
[docs/api/openapi.yaml](docs/api/openapi.yaml), and a running server exposes it
at <http://127.0.0.1:3000/api/openapi.json>. See
[API recipes](docs/api/recipes.md) for examples.

## Documentation

Using Decant:

- [Sources and where Decant finds them](docs/sources.md)
- [How the analytics are calculated](docs/analytics-methodology.md)
- [Pricing estimates and their sources](docs/pricing.md)
- [What the archive stores, and how sync and deletion work](docs/data-lifecycle.md)
- [Install channels, updates, and release verification](docs/distribution.md)
- [Local API routes](docs/api/routes.md) and [recipes](docs/api/recipes.md)
- [Operational logging](docs/logging.md)

Working on Decant:

- [Contributing guide](CONTRIBUTING.md)
- [Architecture](docs/architecture.md)
- [Adding a source](docs/adding-a-source.md)
- [Guidance for coding agents](AGENTS.md)

## Contributing

Contributions are welcome. Bug fixes, pricing updates, and documentation fixes
can go straight to a pull request. New sources, commands, UI features, and
changes to existing behavior need an issue or a
[discussion](https://github.com/dosu-ai/decant/discussions) first, where a
maintainer agrees on the direction and scope.

To run Decant from source, install Bun 1.3 or newer, then:

```sh
git clone https://github.com/dosu-ai/decant.git
cd decant
bun run dev
```

`bun run dev` installs dependencies, starts the UI at <http://127.0.0.1:3000>,
indexes your sessions, and watches for changes. Before you open a pull request,
run:

```sh
bun test
bunx tsc --noEmit
bunx biome check .
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full checklist, including
commit signing and the pull request template. Coding agents should also read
[AGENTS.md](AGENTS.md).

Use synthetic session data in issues and tests. Real transcripts can contain
source code, prompts, credentials, and local paths.

## Community and support

- Ask questions and share ideas in
  [GitHub Discussions](https://github.com/dosu-ai/decant/discussions).
- Report bugs with the
  [issue templates](https://github.com/dosu-ai/decant/issues/new/choose), and
  paste the output of `decant doctor`. It reports versions, platform, and
  per-source counts without any transcript content.
- Report security vulnerabilities privately as described in
  [SECURITY.md](SECURITY.md).
- Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## About Dosu

Decant is built and maintained by
[Dosu](https://dosu.dev?utm_source=decant&utm_medium=github&utm_campaign=attribution&utm_content=about),
Knowledge Infrastructure for Agents. Dosu helps make agents faster, cheaper,
and more effective. Decant shows what your agents spent, read, and touched via
your agent logs.

## Acknowledgments

Decant was inspired in part by
[Letta's Trajectory](https://github.com/letta-ai/trajectory), which normalizes
agent transcripts across runtimes into a shared record format.

## License

Decant is licensed under the [Apache License 2.0](LICENSE).
