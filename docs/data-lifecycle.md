# Archive and data lifecycle

Decant reads coding-agent logs into a local SQLite archive. The source logs and
the archive have different jobs: source logs are the durable record produced by
Claude Code, Codex, Gemini CLI, OpenCode, Cursor CLI, GitHub Copilot CLI, or
Copilot Chat in VS Code, or an ATIF trajectory file another agent wrote. `~/.decant/decant.db` is a searchable, rebuildable
index plus Decant-owned user state.

Nothing in this lifecycle uploads transcripts or calls a hosted service. It does
copy them onto your disk. See
[What the archive stores](#what-the-archive-stores) for what lands in the
archive, how to inspect it, and how to remove it.

## Source logs and the archive

By default Decant discovers:

- Claude Code sessions under `~/.claude/projects`;
- Codex sessions under `~/.codex/sessions` and source-archived sessions under
  `~/.codex/archived_sessions`. A forked Codex subagent's rollout replays the
  thread it forked from before its own history. Decant stores the subagent
  under its own session ID and skips the replayed records, which the parent's
  rollout already holds;
- Gemini CLI sessions under `~/.gemini/tmp/<project>/chats`, including
  subagent transcripts nested under `chats/<parent-session-id>/`, which link
  to their parent session. Decant reads the adjacent `.project_root` sidecar
  for the workspace path and leaves the project unset when that sidecar is
  absent or empty. Gemini session files are event logs. Decant replays
  checkpoint and rewind records the way Gemini CLI does, so a rewound turn or
  a re-recorded message is stored once.
- OpenCode sessions in `~/.local/share/opencode/opencode.db` and any
  `opencode-<channel>.db` beside it. The directory comes from
  `--opencode-dir`, `DECANT_OPENCODE_DIR`, `OPENCODE_DATA_DIR`, or
  `$XDG_DATA_HOME/opencode`, in that order. `OPENCODE_DB`, when set, names an
  explicit extra database file that is read in addition to that directory.
  Decant opens the databases read-only, never writes to them, and never
  checkpoints them. Decant reads OpenCode 2.x sessions (`session_v2` and
  `session_message`) and OpenCode 1.x sessions (`session`, `message`, and
  `part`, from OpenCode 1.2 on), including databases only 1.x ever opened.
  Each session becomes its own source `<database>#<session id>`. One session
  can have several copies: in several databases, or in both layouts of one
  database, because OpenCode 2.x migrates 1.x sessions into its own tables and
  a 1.x binary can keep writing a session after that. Decant reads the copy
  updated last. A tie within one database goes to the 2.x copy, which is the
  usual state of a freshly migrated session, and a tie across databases goes
  to the database path that sorts first. When the copy Decant reads moves to
  the other layout, the next sync re-ingests the session from it. A fork's
  rows inherited from its parent are skipped by their timestamps (see
  [analytics methodology](analytics-methodology.md#token-and-cost-totals),
  which also covers sessions OpenCode migrated from 1.x). An early 2.x
  preview database from before OpenCode split its tables (`opencode-next.db`
  with `session_message` but no `session_v2`) is skipped with a warning until
  a 2.x release converts it, and is never read as 1.x. Sessions in the JSON
  `storage/` directory that OpenCode used before 1.2 are not read.
- OpenCode 1.x's cached models.dev catalog, for context windows of sessions
  in a database that holds no catalog of its own (OpenCode 2.x keeps it in
  the database; 1.x does not). The file is `OPENCODE_MODELS_PATH` when that is
  set, as in OpenCode, else `$XDG_CACHE_HOME/opencode/models.json` (default
  `~/.cache/opencode/models.json`). Decant reads it read-only, at most once per
  sync, and never fetches a catalog. When the file is missing (logged at info
  level) or unreadable (a warning), the context window stays unknown, and the
  affected sessions are re-derived once on the first sync that can read it.
- Cursor CLI chats under `~/.cursor/chats/<workspace>/<chat>/`, or the
  directory from `--cursor-dir` or `DECANT_CURSOR_DIR`. Each chat is a SQLite
  `store.db` with a `meta.json` beside it. Decant reads chats whose
  `meta.json` sets `hasConversation` and skips the rest. A subagent's store
  has no `meta.json`. Decant reads it when its metadata names a parent agent,
  links it to that chat, and takes its working directory from the
  environment block Cursor injects. Stores are opened
  read-only. When a store's directory cannot hold a `-shm` file (a read-only
  mount, for example), Decant falls back to SQLite's immutable mode, which
  reads `store.db` alone and ignores locks and the WAL, so it does so only
  when `store.db-wal` is absent or empty. A store with WAL data a read-only
  open cannot see, or one another process has locked, counts as failed with
  a diagnostic and is not recorded, so the next sync retries it. To read a
  store with pending WAL data, mount the chats directory read-write or close
  the chat in Cursor so it checkpoints. A store whose recorded agent ID
  changes replaces the session Decant filed for it instead of adding a
  second one, and the new ID keeps the old one's archived or deleted state.
  Cursor records no token usage, so these sessions keep token and cost
  totals unavailable.
- GitHub Copilot CLI sessions under
  `~/.copilot/session-state/<session id>/events.jsonl`, or the directory from
  `--copilot-dir` or `DECANT_COPILOT_DIR`. With neither set, Decant follows
  `COPILOT_HOME` to `$COPILOT_HOME/session-state`. Each session is an
  append-only event log, read read-only. Explicit `--path` imports also honor
  the configured Copilot directory when it has a custom name. Subagent events are in the same file
  and stay part of the parent session. When
  `COPILOT_SESSION_EVENT_LOG_ROTATION_BYTES` is set, Copilot moves older
  history into `events.<n>.jsonl` archives and starts a new `events.jsonl`
  that replays that history. Decant reads only `events.jsonl`.
- Copilot Chat in VS Code sessions in VS Code's `User` directory, or the
  directory from `--vscode-copilot-dir` or `DECANT_VSCODE_COPILOT_DIR`. With
  neither set, Decant reads both VS Code's and VS Code Insiders' `User`
  directories. A workspace window's sessions are
  `workspaceStorage/<id>/chatSessions/<session id>.jsonl`, and an empty
  window's are under `globalStorage/emptyWindowChatSessions/`. VS Code 1.109
  and later write each session as a change log that it appends to and
  sometimes rewrites whole. Earlier builds wrote `<session id>.json`. Both are
  read read-only, and Decant re-reads the whole file when it changes. VS Code
  keeps the old `.json` after it moves a session to the log, so Decant reads
  the `.jsonl` when both exist. When VS Code copies an empty window's session
  into a workspace, Decant reads the copy written most recently. It skips
  `globalStorage/transferredChatSessions`, which holds short-lived copies.
  Explicit `--path` imports of these storage trees also exclude extension
  journals and databases outside the chat-session directories, including when
  `--vscode-copilot-dir` points at a relocated root.
- ATIF trajectory files under `~/.decant/atif`, or the directory from
  `--atif-dir` or `DECANT_ATIF_DIR`, read recursively and read-only. No agent
  writes there; it holds trajectories a user copies in. Symbolic links inside
  it are not followed, so point the setting at a Harbor `jobs` directory
  instead of linking one. See [ATIF imports](#atif-imports).

VS Code mutation logs are replayed in order. Malformed initial states, paths,
and array updates produce diagnostics and are skipped without discarding the
last valid state, and later valid updates still apply. Mutation paths cannot
replace an object's prototype.

`decant sync` inserts new sessions and replaces changed ones transactionally.
Unchanged files are skipped by size and modification-time checks (for a Cursor
chat, the existence, size, and nanosecond modification time of each of
`store.db`, `store.db-wal`, and `meta.json` if present, since a running chat appends to
the WAL and a checkpoint can move bytes between files within one second), and
unchanged OpenCode sessions by their per-session change key, unless an updated
ingest pipeline requires reprocessing them. A 2.x session's change key is built
from the session's update time and its message count, highest sequence, and
newest message update. A 1.x session's key covers the session's update time,
its message and part counts, the newest and summed update times of its
messages and of its parts, and a digest of the session's title, archive time,
and usage columns, because OpenCode 1.x renames or archives a session without
moving its update time. A 2.x session that also has a 1.x copy in the same
database (one OpenCode migrated) appends that copy's key, because its usage is
read from that copy, so a change there re-derives it. The two layouts' keys
never coincide, so a session whose copy moves to the other layout is always
re-ingested. An OpenCode
session's change key also covers the MCP server names from the OpenCode
configs that apply to its directory, so editing those names re-derives the
affected sessions once. After a parser correction, the next
sync re-ingests sources with an older pipeline revision once, refreshing tokens,
cost estimates, and derived analytics while preserving session IDs and local
archive state. This requires the source files to remain available. Sync also
refreshes SQLite's planner statistics as it goes, so the first sync into a new
archive stays linear in its size; see
[Planner statistics](architecture.md#planner-statistics). Watch mode
combines native filesystem events with a periodic sweep so missed notifications
do not leave the archive stale. Events are debounced so a burst of writes becomes
one sync, and a log an agent keeps writing still syncs about every 5 seconds
instead of waiting for the agent to pause. OpenCode database directories are watched
non-recursively, and because a running OpenCode's later writes may raise no
file event, the watcher also checks each database and its `-wal` file every 2
seconds by size and modification time, even with `--no-fs-watch`. The watcher
only reads file metadata and never opens an OpenCode database; the sync it
schedules opens it read-only. Cursor chat directories are watched recursively,
ignoring `-shm` changes, which every read of a store makes. The Copilot
session-state directory is watched recursively, reacting only to changes to a
session's `events.jsonl`, not to the plans, checkpoints, and files Copilot
also keeps in each session directory. VS Code's `workspaceStorage` directory is
watched recursively, reacting only to files directly in a workspace's
`chatSessions` directory, and its `emptyWindowChatSessions` directory is
watched on its own.

Sync repairs Copilot compaction metadata from retained message records and
recomputes affected context peaks. This also works for compressed messages
whose original journals are gone. Records without a pre-compaction token count
keep it unavailable, and completed repairs are skipped on later syncs.

The archive stores normalized messages and blocks, canonical raw records,
tools, files, costs, context rollups, diagnostics, recommendations, and local
session state. Deleting or rebuilding the archive does not delete the source
logs or databases.

## Trajectory exports

`decant export <id> --as trajectory` emits Letta's `trajectory-v1` record
format from the normalized archive. It does not change session discovery or
send data to Letta. Source labels are `claude-code`, `codex`, `gemini-cli`,
`opencode`, `cursor`, `copilot-cli`, and `vscode-copilot-chat`.

Exports preserve recorded tool success/failure in the optional `ok` field;
when the source omits an authoritative outcome, the field stays absent.
Decant assigns unique IDs to repeated calls and pairs their results in
occurrence order, pairing only with calls already recorded. Orphan and surplus
results cannot consume a later call's result slot. The export report counts
renamed IDs, orphan and surplus results, omitted blocks, truncated output, and
filled timestamps. The archive
retains the original records and full tool output.

The exported format is intended for model consumption: it omits harness
instructions and unsupported blocks, caps tool arguments and results, and
requires at least one user and assistant record. Use JSON export when you need
Decant's session totals and retained normalized transcript rather than this
filtered format.

## ATIF exports

`decant export <id> --as atif` writes one
[ATIF](https://harborframework.com/docs/agents/atif) document, the trajectory
format Harbor and Terminal-Bench use, declared as `ATIF-v1.7`. `--all --out
<dir>` writes `<id>.atif.json` files. Agent names follow Harbor's:
`claude-code`, `codex`, `gemini-cli`, `opencode`, `cursor-cli`, and
`copilot-cli`. Harbor has no VS Code agent, so Copilot Chat sessions use
`vscode-copilot-chat`, the trajectory export's label. The root's `extra`
carries the session's `cwd` and `git_branch`, and `repository` when the
project's [repository identity](#repository-identity) is known.

User text becomes `user` steps, and system messages and Codex injected context
become `system` steps. Each run of consecutive assistant messages becomes one
`agent` step holding its text, reasoning, and tool calls. A change of model or
of sidechain status starts a new step. Each tool result is
attached to the step that made the call, because ATIF requires an observation's
`source_call_id` to match a call in the same step. Recorded tool failures go in
the result's `extra.is_error`. Repeated call IDs are renamed and paired with
results as in trajectory exports. Tool arguments and results are not
truncated.

ATIF counts `prompt_tokens` inclusive of cached input and `completion_tokens`
inclusive of reasoning. Decant stores input net of cache, so each step's
`prompt_tokens` is input plus cache reads plus cache writes, and
`cached_tokens` is cache reads. ATIF has no cache-write field, so writes go in
`metrics.extra.cache_write_tokens`. `final_metrics` comes from the session
totals. `total_cost_usd` is Decant's estimate at current rates, with
`extra.cost_source` saying whether a source-recorded cost was used, and
`extra.total_reasoning_tokens` appears when the source reports or Decant
infers reasoning. Steps carry no `cost_usd`. A source that records no usage,
such as Cursor CLI, gets no token totals rather than zeros.

Subagent sessions are embedded in the root's `subagent_trajectories` and
linked from the spawning call's observation with `subagent_trajectory_ref`.
When a parent reuses a spawn call ID, each subagent links to the latest call
recorded before it started. A subagent whose spawner cannot be identified,
including the descendants of a subagent with nothing to export, is still
embedded and counted as unlinked in the export report.
The root's totals include its embedded subagents, as ATIF describes. An
embedded trajectory's totals likewise include the subagents it spawned, and
`final_metrics.extra.includes_subagents` marks any trajectory whose totals do,
and `final_metrics.extra.session_metrics` then gives that trajectory's own
share (`total_prompt_tokens`, `total_completion_tokens`, `total_cached_tokens`,
`total_cache_write_tokens`, and `total_cost_usd`). `session_metrics` is absent
when the trajectory's own session records no usage, even if its subagents do,
so the rolled-up totals are then not its own. Sum only the root's totals to
avoid counting nested subagents twice. Claude
compaction boundaries become
`system` steps with `extra.context_management` set to a `replace` compaction,
and the summary that follows is a `user` step marked
`extra.is_compact_summary`.

### Mirroring to a folder

`decant export --mirror <dir>` keeps a folder of ATIF documents for other
tools to read, one per session. It syncs first, like other exports. It writes
every session you have not archived, plus every subagent of one, since the
parent's document points at it. Each document lives at
`<tool>/<name>.atif.json`, where the name is the source session ID when that
ID is lowercase letters, digits, `.`, `_`, and `-`, at most 100 characters,
and not a name Windows reserves. Any other ID gets a readable prefix, `~`, and
a digest of the exact ID, so two IDs that differ only in case still get
different files. The path depends only on the session, so it stays the same
when the archive is rebuilt.

Every document stands alone. A subagent is its own file rather than embedded,
and the spawning call's `subagent_trajectory_ref` names it with a
`trajectory_path` relative to the parent's file. Each document's
`final_metrics` therefore cover that session alone, so summing every file
counts nothing twice. `trajectory_id` is prefixed with the tool, as in
`claude_code:<id>`, in documents and references alike, so sessions from two
tools never share one. ATIF has no field naming a trajectory's parent, so a
subagent's `extra` carries `parent_session_id` and `parent_trajectory_path`.
When the parent has nothing to export, they name the nearest ancestor that
has a file.

The working directory (`extra.cwd`) is left out, since the folder may be
shared and `extra.repository` names the project without a local path. Tool
calls and results keep the paths the agent wrote.

Running the command again rewrites only the documents whose content changed.
Each write goes to a new owner-only (`0600`) temporary file that is renamed
over the document, so a reader never sees a partial document, and the
temporary file is removed if the rename fails. A rewritten document keeps any
read access others had to it, so one you shared stays readable, but never
their write or execute access. A document that is a symbolic link is
replaced, not followed, and a tool folder that is a link stops the mirror with
an error. Unchanged files keep their modification times. Decant never deletes
files from the folder, so a session deleted or archived in Decant keeps its
last document there. A folder Decant creates is owner-only
(`0700`), and one that already exists keeps its mode. Decant's own ATIF import
reads the folder back with subagents linked, under the tool-prefixed IDs.

## ATIF imports

Decant also reads ATIF documents as a source, with the tool ID `atif`. A
`.json` file counts when its first 64 KiB declare an `ATIF-v` schema version,
or when it carries one of Harbor's names (`trajectory.json`,
`trajectory.cont-<n>.json`, `trajectory.summarization-<n>-*.json`) or the
`.atif.json` suffix that `decant export --all --as atif` writes. Any
`ATIF-v1.0` through `ATIF-v1.8` document is read. A newer version is read the
same way and reported as an `unknown_record_type` diagnostic, as are unknown
step sources and content part types. A file that is not valid JSON, or has no
`steps` array, becomes one `unparsed_line` diagnostic and an empty session.

Each trajectory becomes a session. The root is filed under the file's path, and
each trajectory in `subagent_trajectories`, nested ones included, under the
virtual path `<file>#<trajectory_id>`. The root's session ID is its
`trajectory_id`, which names one document. Without one it is the `session_id`
followed by `/` and the file name without its `.atif.json` or `.json`
extension, because ATIF lets a
trajectory and its continuation files share one `session_id`. The file name is
left off for Harbor's plain `trajectory.json` and for a file named after the
run. A document with neither ID uses the file name plus a digest of its path. A
subagent's ID is its `trajectory_id` under the root's, with a `#<n>` suffix if
two would otherwise match. A ref in an observation that names an embedded
`trajectory_id` makes that trajectory a subagent of the one holding the ref,
spawned by the result's `source_call_id`. An embedded trajectory no ref names
is a subagent of the trajectory that embeds it, which for a top-level entry is
the root. A ref whose `trajectory_path` is set and whose
`trajectory_id` names nothing embedded resolves beside the document instead.
Once the file at that path is in the archive, its session is linked as a
subagent of the referencing session, and it becomes a top-level session again
if the reference is later removed. Deleting a subagent session also deletes
any subagent the document later adds beneath it. When a file drops an embedded
subagent, the next sync removes that subagent's session. Two files holding the
same document keep one copy: the one read last, with its own embedded
subagents. A document is read again when its size or modification time,
compared to the sub-second, changes.

`system`, `user`, and `agent` steps become system, user, and assistant
messages. An agent step's `reasoning_content`, text, and `tool_calls` become
thinking, text, and tool-use blocks, and its `observation` becomes a following
tool message: a result with a `source_call_id` is that call's result, with
`extra.is_error` as its failure flag, and a result without one is text. Image
parts become image blocks and audio parts other blocks, each holding the media
path. Timestamps are stored in UTC, and a timestamp without a zone is read as
UTC. Steps with `is_copied_context: true` repeat turns from another
trajectory, so they are skipped and counted in the session's
`raw_meta.copiedContextSteps`. A system step whose
`extra.context_management.type` is `compaction` counts as a compaction.

Token usage reverses the export mapping. Each agent step's input is
`prompt_tokens` less `cached_tokens` and the cache writes in
`metrics.extra.cache_write_tokens`, `cache_creation_input_tokens`, or
`cache_write_input_tokens`. When that difference is negative, the producer left
writes out of `prompt_tokens`, and only cache reads are subtracted.
`completion_tokens` is output, and `metrics.extra.reasoning_tokens` (or
`thoughts_tokens`) is the reasoning part of it. Session totals are the sum of
the steps, because a root's `final_metrics` can count its subagents or earlier
continuation files. Two cases take `final_metrics` instead. A trajectory with no
per-step metrics and no embedded subagents uses them as its totals. A
trajectory Decant exported (`extra.exporter: "decant"`) uses its
`final_metrics`, or `final_metrics.extra.session_metrics` when they include
subagents, because per-step metrics undercount sources such as Codex that
record usage once per turn. A step that records `cost_usd` without token
counts still counts toward cost. When no step records a cost, a model Decant
cannot price takes the run's `final_metrics.total_cost_usd`, but only when
nothing else shares that total: no embedded subagents and no `trajectory_path`
refs, or a Decant `session_metrics.total_cost_usd`. A trajectory whose only
usage is `final_metrics` (zero totals included) or a recorded cost is not shown
as unavailable. Harbor's
OpenCode converter currently writes `prompt_tokens` without cache writes,
against the spec. Nothing in its output tells that apart from a corrected
converter, so Decant follows the spec, and such a trajectory's input reads low
by the cache-write count. A trial's Harbor job
directory, the parent of `<trial>/agent/`, is its project. Otherwise the
trajectory's `extra.cwd`, as Decant's export writes it, is. An embedded
subagent that records neither takes its root's.

Tool names keep the producing agent's conventions. When `agent.name` is one of
Harbor's names for a source Decant reads natively (`claude-code`, `codex`,
`gemini-cli`, `opencode`, `cursor-cli`, `copilot-cli`, or
`vscode-copilot-chat`), file and subagent attribution use that source's rules.
Other agents use Claude Code's file tool names, then the Codex shell and patch
rules. Exporting an imported session as ATIF keeps its original agent name, or
writes `atif` when the document had none.

## What the archive stores

The archive is a searchable copy of the transcript content Decant retains, not
just a summary of it. Decant canonicalizes stored JSON instead of preserving
source whitespace and key order. Parsers also omit non-transcript event records
that duplicate retained messages or contain only stream metadata.

| What it holds | Columns |
| --- | --- |
| The full source record for every retained transcript message, canonicalized as JSON and optionally compressed losslessly | `message.raw` |
| Prompt, response, and reasoning text | `block.text` |
| A display title, normally the first 120 characters of the opening prompt or a provider title | `session.title` |
| Tool arguments, including shell commands, file paths, and patch bodies | `block.tool_input`, `tool_call.input` |
| Tool output, including the contents of files an agent read | `block.tool_result`, `tool_call.output_preview` |
| Absolute local paths for the working directory, the source log, and every file an agent touched | `session.cwd`, `session.source_path`, `file_ref.path`, `ingest_source.path` |
| Absolute local paths of every project and worktree you ran agents in | `project.path`, `project.root_path` |
| The remote of each project's repository, as a host and path with any credentials removed | `project.repo_remote` |
| Malformed records within byte and depth limits, retained locally | `ingest_issue.raw_line` |

Only `block.text`, `block.tool_name`, and `block.tool_input` are full-text
indexed. `block.tool_result` and `message.raw` are stored but not searchable,
which makes them harder to find, not absent.

Large source records use standard Zstandard BLOBs in `message.raw` when the
compressed record and its metadata take less space than the original JSON.
Small records stay as JSON text. Compression preserves the complete canonical
JSON, including fields Decant does not recognize. It does not truncate or redact
content. Normalized transcript blocks and the full-text index stay unchanged.

For compressed records, `message.raw_meta` holds the small JSON projection that
transcript and accounting queries need, and `message.raw_bytes` records the
original UTF-8 byte count. These queries read the projection without inflating
the full source record. Code reading complete source records should use
`decodeMessageRaw` from `src/message-storage.ts` for both TEXT and BLOB rows.

There is no redaction step. Decant does not detect, mask, or strip secrets,
tokens, keys, or personal data. Whatever your agents read, and whatever was
pasted into a session, is in the archive in the clear.

### Permissions

Decant creates `~/.decant/decant.db` and its `-wal` and `-shm` sidecars at mode
`0600`, and creates `~/.decant` at `0700`. It sets the directory mode only when
it creates the directory; a directory that already existed keeps whatever mode
its owner gave it. Check what yours actually are:

```sh
ls -ld ~/.decant
ls -l ~/.decant/decant.db
```

These are filesystem permissions, not encryption. The archive is a plain SQLite
file, so anything that can read it can read every transcript in it, including a
backup, a synced folder, or another process running as you.

Terminal, agent, and IDE preferences saved from the UI live apart from the
archive in `~/.config/decant/settings.json`, or under `DECANT_CONFIG_DIR` when
set. The file is written at mode `0600`. When it exists but cannot be parsed,
Decant uses the detected defaults and leaves it alone until the next save, which
moves it aside as `settings.json.corrupt-<timestamp>` before writing a new one.

When update checks are on, the result of the last check is cached next to it in
`update-check.json`, holding the time of the check and the newest version it
found.
Decant asks the npm registry again only after a day has passed, or an hour
after a failed check, which the file marks with `failed`. `decant update` and `decant update --check` always ask and
refresh the cache. Deleting the file only causes one more check.

### Inspecting and removing it

`decant db info` reports where the archive is, how large it is, and how much it
holds. It prints no transcript content.

```sh
decant db info
decant db info --full   # adds fts_rows and text_bytes: a full scan, slow on a large archive
```

`--full` also reports `compressed_messages` and `raw_stored_bytes`. The latter
counts stored source-record bytes plus their metadata. `text_bytes` still
counts the original uncompressed source records and normalized transcript text.

### Compressing an existing archive

New and changed sessions use lossless source-record compression when they are
ingested. Opening an existing archive adds the storage columns without
rewriting its retained records. Compress those records explicitly with

```sh
decant --no-sync db compact
```

Stop any running Decant server before upgrading and compacting the archive,
then restart it with the new build. A process running an older build cannot
read compressed source records. Keep a consistent backup before maintaining a
large archive. SQLite's final `VACUUM` can need up to twice the archive's size
in additional free disk space for its temporary copy and journal.

`db compact` never syncs source directories. It verifies that every compressed
record decodes to exactly the stored text before saving it, commits bounded
batches, and then runs `VACUUM` to return freed pages to the filesystem. It
prints progress while compressing and before vacuuming. If interrupted, run it
again. Completed batches stay committed, already compressed records are
skipped, and a failed vacuum can be retried with `decant --no-sync db vacuum`.
Session IDs, user state, normalized content, and search results are preserved.

Delete one session tree from the CLI, or use **Delete session** in the web UI:

```sh
decant ls                      # find the id
decant session rm 42 --dry-run # what would go, without deleting it
decant session rm 42 --yes     # --yes is required once it has descendants
decant db vacuum
```

`session rm` deletes the session **and its descendant tree**, so `--yes` is
required whenever the target has descendants, and `--dry-run` reports the blast
radius without touching anything.

#### If you delete something by mistake

There is no un-delete command, and it is not enough to re-run `sync`. Deletion
writes tombstones that make later syncs skip the deleted source files on purpose.
The source JSONL remains on disk, so you can restore deleted sessions by clearing
the tombstones and ingest bookkeeping before syncing again. Close `decant serve`
first, and back up the archive before editing it.

The archive removes the parent-child links during deletion. After deleting a
tree, it cannot reliably identify only that tree's tombstones and source paths.
The following recovery therefore restores **every** deleted session whose source
JSONL still exists:

```sh
sqlite3 ~/.decant/decant.db \
  "BEGIN IMMEDIATE;
   DELETE FROM session_user_state WHERE state = 'deleted';
   DELETE FROM ingest_source WHERE status = 'skipped_deleted';
   COMMIT;"

decant sync
```

Both deletes are required. Clearing only `session_user_state` leaves each file
skipped by the unchanged-metadata check, so the sessions do not come back. This
rebuilds sessions from the source logs rather than recovering deleted archive
pages, and only works while those source files still exist.

Both paths remove the live rows and their full-text index entries. SQLite can
leave deleted transcript text recoverable in freed pages until `decant db
vacuum` rewrites the archive.
`decant db info` reports `freelist_bytes`, and a non-zero value means a vacuum is
owed. The converse does not hold. Freed pages are reused: the next sync, and any
read command that syncs first, writes new rows into them. So `freelist_bytes` can
read back at or near zero while deleted text still survives in the unused tail of
a page something else now occupies. Run `db vacuum` as the step that follows a
delete, rather than waiting for the number to look large.

To remove everything Decant holds:

```sh
rm -rf ~/.decant
```

Under Docker the archive lives in the **named** volume mounted at
`/var/lib/decant`, and a named volume outlives its containers. Neither `--rm`
nor `docker rm` removes it; only removing the volume does:

```sh
docker volume rm decant-data
```

The source mounts in the documented `docker run` are read-only (`:ro`), so
Decant cannot modify your Claude Code or Codex logs from inside the container.

Removing the archive never removes the source logs. Those stay where Claude Code
and Codex wrote them.

## Repository identity

A local path names a repository differently on every machine and in every
worktree, so Decant also records the repository's remote as
`project.repo_remote`: `github.com/acme/widget` for both
`git@github.com:acme/widget.git` and `https://github.com/acme/widget`. Any sync
that ingests a session reads it from the Git config on disk, for existing
projects as well as new ones. Decant does not run `git` and does not contact
the remote.

The lookup starts at the project's directory and walks up to the working tree
that holds it, following a linked worktree to the repository it belongs to. It
uses `origin`, or the only remote when there is no `origin`. The scheme, user,
password or token, port, query, and a trailing `.git` are dropped before the
value is stored. A local path or `file:` remote is not recorded.

A project whose directory is gone, such as a removed worktree, takes the remote
of the repository root it resolved to. When neither can be read, the stored
value stays as it was, so a project keeps its identity after its checkout is
deleted. A project stays unset when its directory was removed before Decant
first read it and it has no root on disk, when its repository has no remote,
and when Decant cannot see the directory at all, as in a container that mounts
only the source logs. Projects that hold only imported ATIF trajectories are
skipped, because their path is a job directory, not the place the agent ran.

## Automatic and explicit sync

Read commands normally sync first. `decant serve` performs a startup sync and
then watches the configured source directories.

The web UI shows the startup sync's progress and loads its results as soon as
it finishes, so a first launch fills the dashboard without a manual sync.

Later watcher and sweep syncs refresh the first page of **Sessions** in place
when it has no project, archive, or text filter. The date range doesn't matter,
so a past range refreshes too, though its rows rarely change. New sessions
appear at the top within a few seconds, without a click, and the table keeps
its rows on screen instead of dropping back to a loading skeleton while it
reloads. These refreshes run at most once every five seconds while an agent is
busy writing its log. They also wait while you are scrolled down the list or
the tab is hidden, because new rows at the top would push your place down the
page. **Update** lights instead, and the list catches up once you scroll back
to the top. If a refresh fails, the rows stay up under a notice with a
**Retry** button. Everywhere else, including later pages, filtered lists,
transcripts, and analytics, background activity only lights the **Update**
button, so it never reshuffles a page while you are reading it.

Set `DECANT_NO_SYNC` or pass `--no-sync` to suppress syncs Decant starts on its
own. With `serve`, this also disables the source watcher. It does not disable an
operator-requested `POST /api/sync` or the UI's **Sync now** action.

Always use `--no-sync` with a scratch database unless you want it populated
from the real default source directories:

```sh
decant --db /tmp/decant-review.db --no-sync serve --no-open
```

### Running in the background

By default the archive only stays current while `decant serve` runs in a
terminal. Turn on **Run in the background** in Settings, or run
`decant service install`, and the OS starts `decant serve --no-open` at login
and restarts it if it fails. On macOS this is a LaunchAgent at
`~/Library/LaunchAgents/dev.dosu.decant.plist` with its log in
`~/Library/Logs/decant/serve.log`. On Linux it is a systemd user unit at
`~/.config/systemd/user/decant.service`, logging to the journal
(`journalctl --user -u decant`). Run `decant service status` to see its state
and `decant service uninstall` to remove it.

The service is the same single process that owns the archive when you run
`decant serve` yourself. It serves the archive and port you chose when you
turned it on, on loopback only, with the default source directories. It does
not carry over `--host`, `--trusted-peer`, `--no-sync`, or source-directory
flags.

A relative `--db` or `DECANT_DB` is stored as an absolute path, because the OS
starts the service in its own working directory. Decant refuses to register a
service when the archive path or its own executable path contains a control
character such as a newline or carriage return, because no quoting keeps one
inside a systemd unit or plist. Running
`decant service install` again with a different archive or port replaces the
registration, whether or not the service is running. On macOS this waits for
the old process to exit, up to 30 seconds, before registering the new command.

Turning it on from Settings hands off: the server you are using registers the
service, then stops, and the service takes over the same address. The page
reloads once the service answers. While another `decant serve` holds the port,
the service waits for it instead of exiting, and a bare `decant` that finds the
service already serving its port opens the browser there.

The service checks its binary once a minute. After `decant update`, a Homebrew
upgrade, or an npm update replaces it, the service waits until the new file
stops changing, then exits and the OS starts the new version. If a sync is
stuck and the service has not stopped 10 seconds after it began, it exits
anyway so the OS can restart it. Homebrew installs register the stable
`$(brew --prefix)/opt/decant/bin/decant` path, so upgrades keep working. Source
checkouts, `npx`, and the container cannot register a service.

## Visible, archived, and deleted

Session state is keyed by stable provider identity rather than the transient
SQLite row id.

| Action | Archive rows | Default reads and statistics | Later sync | Source log |
| --- | --- | --- | --- | --- |
| Archive | Retained | Hidden, including effective descendants | Remains archived | Unchanged |
| Restore visibility | Retained | Visible unless an ancestor or source state still hides it | Remains visible | Unchanged |
| Delete | Selected session tree is physically removed; deleted text may persist in freed pages until `db vacuum` | Excluded | Tombstones prevent resurrection | Unchanged |

Archiving records a direct override only on the selected session. Descendants
inherit effective visibility from their current ancestry. This lets a child
that was archived independently stay archived after its parent is restored.

Deleting applies to the existing descendant tree and keeps identity tombstones.
Provider lineage metadata lets a late-arriving descendant inherit the deletion
instead of reappearing after a later sync. Deleted sessions are not returned by
`include_archived=true` and cannot be restored through the normal session-state
API after their rows are removed.

A provider can also mark a session archived in its own source layout. Clearing
a Decant user override does not move or rewrite provider files.

## Sensitive sessions

Deleting a session tree removes its transcript-derived rows from Decant and
prevents the configured source from re-ingesting that identity. The original
Claude Code, Codex, Gemini CLI, OpenCode, Cursor CLI, GitHub Copilot CLI, or
VS Code record remains on disk.
If the source record must also be removed, manage it through the owning tool or
delete that source file only after deciding that losing the original transcript
is intended. OpenCode keeps every session in one shared database, so deleting
its file would remove all OpenCode history. Remove an individual session from
within OpenCode instead.

Removing the rows may leave their text recoverable in freed pages. For a session
that was sensitive enough to delete, run both commands:

```sh
decant session rm <id> --yes
decant db vacuum
```

See [Inspecting and removing it](#inspecting-and-removing-it) for the rest of
the removal paths.

Never commit a real archive, transcript, exported session, source path dump, or
fixture derived from private content. Synthetic fixtures are the only session
data allowed in this repository.

## Rebuilds and migrations

Source logs are sufficient to rebuild transcript-derived state. Supported
archives migrate to the current baseline on open; older archives are
rebuild-only. The next sync backfills persisted economics, parser enrichments,
and context rollups when required.

Session facets such as `active_seconds` and file references, including their
extensions, are derived from the source file at ingest. Corrections reach
existing sessions through a pipeline-revision re-ingest, which requires the
source to still exist. A session whose source is gone keeps the totals it was
stored with. Stored context peaks are the exception: when their rules change, a
migration clears them and the next sync recomputes them from retained rows. Persisted
economics vectors are versioned separately and recompute from the archive's
own rows, so they refresh even when the source is gone.

Earlier releases filed a forked Codex subagent under the thread it forked
from, replacing that thread's session. When a sync re-reads such a fork,
Decant removes the misfiled row and stores the subagent under its own ID. The
parent comes back from its own rollout while that file still exists.

Subagent parent links are resolved at the end of any sync that wrote or
tombstoned a session. A sync that finds every source unchanged leaves the
existing links alone, so a change to the inference rules ships with an ingest
pipeline revision bump that re-derives them.

Activity vectors are versioned separately from source ingest. When activity
classification rules change, the next sync rebuilds older vectors from retained
archive rows, including sessions whose source journals are gone. Later syncs
skip the rebuilt vectors.

Each session's usage is also stored split by model and price tier in
`session_model_usage`, derived from the per-request usage already kept on its
messages. Sync builds the split for sessions stored before the table existed,
or under an older split rule, from those archived rows, so it reaches sessions
whose source files are gone without a re-ingest. On a large archive the first
backfill can take several seconds; later syncs find nothing to rebuild.

Costs are materialized at ingest and reconciled with current pricing on every
sync. This includes unchanged and archived sessions, even when their source
files are no longer available. Session costs and cached activity cost components
update in one transaction. Recommendations and server caches refresh after
repricing. No archive rebuild is needed, and user state is preserved.

Local state that does not come from provider logs belongs to the archive. That
includes recommendation status, session archive overrides, and deletion
tombstones.
Preserve the database before a rebuild if that state matters, and do not assume
it can be reconstructed from transcripts.

`session_model_usage.reported_cost_usd` holds the cost a source recorded for a
model Decant cannot price (OpenCode records one per request). It is set when
the usage rows are derived, at ingest or by a format-version backfill, and is
part of the cost every sync reconciles, so a rate added later replaces the
recorded figure with Decant's estimate on the next sync. The reverse needs a
re-derive: rows derived while a model had a rate store no recorded figure, so
removing a rate requires bumping `MODEL_USAGE_FORMAT_VERSION`, which rebuilds
the rows from the stored messages without the source database.

## API visibility

Default lists, full-text search, command-palette search, statistics, tools,
files, and economics exclude user-hidden sessions. Statistics operations that
accept `include_archived=true` add archived sessions back; deleted sessions and
their content remain absent.

The same surfaces also skip sessions that hold no conversation: Claude Code
transcripts containing only local slash-command output, and Codex threads that
were created but never sent a prompt. Their rows stay in the archive and remain
readable by id. Each becomes visible once its source gains a real prompt or
reply.

See the Response and archive semantics section of docs/api/routes.md for the
wire behavior and [How Decant analytics work](analytics-methodology.md) for the
effect on analytical denominators.

Parser diagnostics retain locations and fixed error messages. Ordinary malformed
records retain their raw text in the local archive's `ingest_issue.raw_line`,
under the same file protection as transcripts. CLI output and logs show only
the error message. Records rejected by byte or depth limits retain no raw text.
Unknown type names remain readable when they match
`^[A-Za-z][A-Za-z0-9_.:-]{0,63}$`; other names use `(unprintable type)` with a
short hash to keep counts distinct.
Oversized files are skipped without changing archived copies or source metadata.
They count as failed in sync reports and are retried on every sync.
