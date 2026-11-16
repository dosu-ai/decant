# Sources

Decant reads the session logs each coding agent already writes on your machine.
It finds them in their default locations, so most installs need no
configuration. This page lists where Decant looks, how to point it somewhere
else, and what each source records.

For how sync discovers, re-reads, and stores each source, see
[Archive and data lifecycle](data-lifecycle.md#source-logs-and-the-archive).

## Default locations and overrides

| Source | Default location | Environment variable | Flag |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects` | `DECANT_CLAUDE_DIR` | `--claude-dir` |
| Codex | `~/.codex` | `DECANT_CODEX_DIR` | `--codex-dir` |
| Gemini CLI | `~/.gemini/tmp` | `DECANT_GEMINI_DIR` | `--gemini-dir` |
| OpenCode | `~/.local/share/opencode` | `DECANT_OPENCODE_DIR` | `--opencode-dir` |
| Cursor CLI | `~/.cursor/chats` | `DECANT_CURSOR_DIR` | `--cursor-dir` |
| GitHub Copilot CLI | `~/.copilot/session-state` | `DECANT_COPILOT_DIR` | `--copilot-dir` |
| Copilot Chat in VS Code | VS Code's `User` directory | `DECANT_VSCODE_COPILOT_DIR` | `--vscode-copilot-dir` |
| ATIF trajectories | `~/.decant/atif` | `DECANT_ATIF_DIR` | `--atif-dir` |
| Hermes Agent | `~/.hermes` | `DECANT_HERMES_DIR` | `--hermes-dir` |

The flags work on `sync`, `watch`, and `serve`.

## Index specific files

`sync --path` ingests only the files or directories you name, and you can
repeat it. This example indexes one file and one directory into a scratch
archive:

```sh
decant --db /tmp/decant.db sync --path ./session.jsonl --path ./sessions
```

## Claude Code

Claude Code 2.1 and later writes each subagent to
`<session id>/subagents/agent-<agent id>.jsonl` beside its parent session. A
subagent started by a dynamic workflow goes one level deeper, under
`<session id>/subagents/workflows/<run id>/agent-<agent id>.jsonl`.
Versions 2.0.28 through 2.0.77 wrote each subagent to
`agent-<agent id>.jsonl` in the project directory. Decant files all of these
as subagent sessions under their parent.

Claude Code 2.0.27 and earlier wrote subagent messages into the parent
session's own file. Decant does not split those messages into a subagent
session, so the parent session's tokens and cost include the subagent's usage.

Claude Code versions before 2.1.307 could write only a placeholder usage
record for a streamed subagent response, without the final token counts.
Decant bills the usage the transcript records, so those subagents' tokens and
cost read low. In testing, 2.1.288 through 2.1.306 showed this.

## OpenCode

Decant supports OpenCode 1.2 and later, reading both its 1.x and its 2.x
session storage. It reads sessions from `opencode.db` (and
`opencode-<channel>.db`) read-only and never writes to them. When the same
session is stored in both layouts, Decant reads the copy OpenCode updated last.
Sessions in the JSON `storage/` directory that OpenCode used before 1.2 are not
read.

When neither `DECANT_OPENCODE_DIR` nor `--opencode-dir` is set, the OpenCode
directory falls back to OpenCode's own `OPENCODE_DATA_DIR`, then
`$XDG_DATA_HOME/opencode`. `OPENCODE_DB` names an explicit extra database file
that is read alongside the discovered directory. `--path` also accepts an
OpenCode `.db` file.

### MCP server names

Decant recognizes OpenCode MCP tool calls by the server names in OpenCode's
config. It reads the global `opencode.json` and `opencode.jsonc` in OpenCode's
config directory (`OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`,
default `~/.config/opencode`). It also reads `opencode.json`,
`opencode.jsonc`, `.opencode/opencode.json`, and `.opencode/opencode.jsonc` in
each session's directory and in every directory above it up to the filesystem
root, and merges the names.

As in OpenCode, files that resolve to the global config directory are not read
again as project configs. Like OpenCode, Decant also reads the file named by
`OPENCODE_CONFIG` in addition to those. `DECANT_OPENCODE_CONFIG` names one file
that Decant reads in place of the global directory's two files. A missing or
malformed config file names no servers.

When a config edit changes the server names that apply to a session, the next
sync re-derives that session. Sessions whose names did not change are skipped
as usual. Run `sync`, `watch`, and `serve` with the same `OPENCODE_CONFIG` and
`DECANT_OPENCODE_CONFIG` values, or each switch re-derives those sessions.

A session's directory comes from its log, so it can be in a place that does not
answer, such as a folder macOS protects while its permission prompt is
unanswered, or a network mount that has gone away. Decant waits up to 2 seconds
for such a place and then skips it. The session is still ingested with the
names from the global configs and from the directories above the skipped one,
and it carries an `unreachable_project_directory` diagnostic. The next sync
after the directory answers again re-derives the session. See
[Project directories that do not answer](data-lifecycle.md#project-directories-that-do-not-answer).

### Context windows

Decant takes context windows from the models.dev catalog that OpenCode caches.
OpenCode 2.x keeps the catalog in its database. For a database without one, as
1.x leaves it, Decant reads `OPENCODE_MODELS_PATH`, else
`$XDG_CACHE_HOME/opencode/models.json` (default
`~/.cache/opencode/models.json`), read-only.

## Cursor CLI

Cursor CLI keeps each chat in its own `store.db` with a `meta.json` beside it.
Decant reads those stores read-only and skips chats whose `meta.json` records
no conversation. A subagent's store has no `meta.json`, so Decant reads it
when the store names its parent chat and files it under that chat.

Cursor records no token usage, so Decant shows tokens and cost for Cursor
sessions as unavailable instead of $0. `--path` also accepts a Cursor
`store.db`.

## GitHub Copilot CLI

GitHub Copilot CLI writes each session to
`~/.copilot/session-state/<session id>/events.jsonl`. Decant reads that file
read-only. When neither `DECANT_COPILOT_DIR` nor `--copilot-dir` is set,
Decant follows `COPILOT_HOME` to `$COPILOT_HOME/session-state`.

Subagent work stays in its parent session because Copilot records it in the
same file. Copilot writes each model call's usage, and per-model totals when a
session exits or checkpoints its usage, so Decant prices those totals at the
underlying model's API rates. That estimate is not a count of Copilot premium
requests.

Decant does not read the rotated `events.<n>.jsonl` archives Copilot writes
only when `COPILOT_SESSION_EVENT_LOG_ROTATION_BYTES` is set. The current
`events.jsonl` replays the earlier history at its start.

`--path` accepts a Copilot journal under `session-state/<session id>/events.jsonl`.
For a custom layout, pass its session root with `--copilot-dir`:

```sh
decant --no-sync --db /tmp/decant-repro.db sync --copilot-dir ./copilot --path ./copilot/example/events.jsonl
```

## Copilot Chat in VS Code

Copilot Chat in VS Code keeps each chat session in VS Code's `User` directory:

- `~/Library/Application Support/Code/User` on macOS
- `~/.config/Code/User` on Linux, following `XDG_CONFIG_HOME`
- `%APPDATA%\Code\User` on Windows

Decant reads VS Code Insiders' `Code - Insiders/User` directory too. One
override names a single `User` directory and replaces both defaults.

A workspace's sessions are in `workspaceStorage/<id>/chatSessions/`, and the
folder they belong to comes from `workspace.json` beside them. Sessions from a
window with no folder open are in `globalStorage/emptyWindowChatSessions/`.
Decant reads both the `.jsonl` change log that VS Code 1.109 and later write
and the `.json` file earlier builds wrote, read-only. `--path` also accepts a
chat session file inside VS Code's storage layout.

Decant does not read Cursor, Windsurf, or other editors built from VS Code.
Sessions that Copilot CLI, Claude, or Codex run inside VS Code keep their
transcripts in those tools' own stores, which Decant reads as those sources.

VS Code records the output tokens of every model call in a request in builds
from April 2026 on, and the last call's prompt size from June 2026 on. The
prompt size includes cache reads, and no cache split is written. Decant stores
those numbers as written, so cost for these sessions is a rough list-price
estimate. A session from an older build has no usage, and Decant shows its
tokens and cost as unavailable instead of $0.

## ATIF trajectories

ATIF (Agent Trajectory Interchange Format) is the trajectory format Harbor
writes for Terminal-Bench and its other evaluation runs. No agent writes to
`~/.decant/atif`. Copy trajectories into it, point `DECANT_ATIF_DIR` at a
Harbor `jobs` directory, or import files once with `--path`. Discovery does
not follow symbolic links inside the directory, so a linked file or job is not
read:

```sh
decant sync --path ./jobs/my-job
decant sync --path ./run.atif.json
```

Decant reads every `.json` file whose head declares an `ATIF-v1.x` schema,
plus Harbor's `trajectory.json`, `trajectory.cont-<n>.json`, and
`trajectory.summarization-<n>-*.json` names, read-only. Sessions are filed
under the `ATIF` source. A trial under Harbor's `<job>/<trial>/agent/` layout
is filed under its job directory as the project.

Each embedded subagent becomes a linked subagent session, and so does a
subagent another trajectory names by `trajectory_path`. Steps marked
`is_copied_context` were copied from an earlier trajectory and are skipped.

Session tokens are the sum of each step's `metrics`, with cache reads and
writes taken back out of `prompt_tokens`. Two kinds of trajectory use
`final_metrics` instead:

- a trajectory with no per-step metrics and no embedded subagents
- a trajectory Decant exported, whose per-step metrics can undercount

Decant prices models it has a rate for and keeps a recorded `cost_usd` for
models it cannot price. A trajectory with neither step metrics nor
`final_metrics` shows tokens and cost as unavailable. See
[ATIF imports](data-lifecycle.md#atif-imports) for the full mapping.

## Hermes Agent

Hermes Agent, from Nous Research, keeps every session in one SQLite database,
`state.db`, in its home directory. Each named profile has its own database at
`profiles/<name>/state.db`, and Decant reads all of them read-only, never
writing to them or starting Hermes. When neither `DECANT_HERMES_DIR` nor
`--hermes-dir` is set, Decant follows `HERMES_HOME`, then Hermes's own default:
`~/.hermes`, or `%LOCALAPPDATA%\hermes` on Windows. A `HERMES_HOME` that names
one profile's directory reads only that profile. Decant does not read the
`sessions/*.jsonl` transcripts older Hermes builds left behind, which Hermes
itself no longer reads.

The transcript is what Hermes shows for the session: history an in-place
compaction archived stays, each turn the compaction copied forward is shown
once, and turns removed by a rewind or edit are left out. A session started by
`delegate_task` is filed as a subagent under its parent. A child that continues
a compressed, reset, or branched conversation is filed as its own session.

Hermes records token usage per session and model, not per message, so Decant
shows each session's tokens and cost split by model but has no per-message
usage and no context-window figures for Hermes. Costs are Decant's estimates
at each model's API rates, not what Hermes or your provider charged.

Hermes names an MCP tool `mcp_<server>_<tool>` and replaces dashes and dots in
both parts with underscores, so the boundary between the server and the tool
is not recorded. Decant splits the name at its first underscore. A server whose
own name holds an underscore or a dash is shown under its first word.

`--path` also accepts a Hermes `state.db` file, or a directory holding one.

## Input limits

Decant reads at most 256 MiB from a transcript file, including a file that
grows during the read. Larger files are skipped and counted as failed in the
sync report. Existing archived copies and source metadata are kept unchanged, so each sync retries
the file. New oversized files create no session. A content-free warning names
the source path. Split them into smaller source files before importing them.
JSONL and OpenCode records and Cursor message blobs have a 16 MiB limit. JSON containers
may nest up to 512 levels. Decant skips records beyond these limits and keeps
reading the remaining records. Whole-document sources cannot skip individual
records when their JSON exceeds the depth limit.

ATIF embedded trajectories may nest up to 128 generations. Decant retains the
root and allowed descendants, skips deeper descendants, and reports a fixed
diagnostic on their parent. These caps allow far more nesting than the source
formats' ordinary message, block, and tool argument structures require.

OpenCode records use the same JSON limits after loading. OpenCode session
materialization and the aggregate size of a Cursor chat are not yet bounded.
