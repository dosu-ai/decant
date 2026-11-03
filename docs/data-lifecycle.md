# Archive and data lifecycle

Decant reads coding-agent logs into a local SQLite archive. The source logs and
the archive have different jobs: source logs are the durable record produced by
Claude Code, Codex, Gemini CLI, or OpenCode; `~/.decant/decant.db` is a
searchable, rebuildable index plus Decant-owned user state.

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

`decant sync` inserts new sessions and replaces changed ones transactionally.
Unchanged files are skipped by size and modification-time checks, and
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
archive state. This requires the source files to remain available. Watch mode
combines native filesystem events with a periodic sweep so missed notifications
do not leave the archive stale. Events are debounced so a burst of writes becomes
one sync, and a log an agent keeps writing still syncs about every 5 seconds
instead of waiting for the agent to pause. OpenCode database directories are watched
non-recursively, and because a running OpenCode's later writes may raise no
file event, the watcher also checks each database and its `-wal` file every 2
seconds by size and modification time, even with `--no-fs-watch`. The watcher
only reads file metadata and never opens an OpenCode database; the sync it
schedules opens it read-only.

The archive stores normalized messages and blocks, canonical raw records,
tools, files, costs, context rollups, diagnostics, recommendations, and local
session state. Deleting or rebuilding the archive does not delete the source
logs or databases.

## Trajectory exports

`decant export <id> --as trajectory` emits Letta's `trajectory-v1` record
format from the normalized archive. It does not change session discovery or
send data to Letta. Source labels are `claude-code`, `codex`, `gemini-cli`,
and `opencode`.

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
| Lines a parser could not read, kept verbatim so they can be diagnosed | `ingest_issue.raw_line` |

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
`update-check.json`: the time of the check and the newest version it found.
Decant asks the npm registry again only after a day has passed, including after
a failed check. `decant update` and `decant update --check` always ask and
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
Claude Code, Codex, Gemini CLI, or OpenCode record remains on disk. If the
source record must also be removed, manage it through the owning tool or delete
that source file only after deciding that losing the original transcript is
intended. OpenCode keeps every session in one shared database, so deleting its
file would remove all OpenCode history; remove an individual session from within
OpenCode instead.

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

Session facets such as `active_seconds` are derived from the source file at
ingest, so a correction to them reaches existing sessions through the
pipeline-revision re-ingest and needs the source to still exist. Persisted
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
