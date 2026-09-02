# Archive and data lifecycle

Decant reads coding-agent logs into a local SQLite archive. The source logs and
the archive have different jobs: source session files are the durable records
produced by Claude Code, Codex, or Cursor CLI; `~/.decant/decant.db` is a searchable,
rebuildable index plus Decant-owned user state.

Nothing in this lifecycle uploads transcripts or calls a hosted service.

## Source logs and the archive

By default Decant discovers:

- Claude Code sessions under `~/.claude/projects`;
- Codex sessions under `~/.codex/sessions` and source-archived sessions under
  `~/.codex/archived_sessions`;
- Cursor CLI chats under `~/.cursor/chats`.

`decant sync` inserts new sessions and replaces changed ones transactionally.
Unchanged files are skipped by metadata and content checks. Watch mode combines
native filesystem events with a periodic sweep so missed notifications do not
leave the archive stale.

The archive stores normalized messages and blocks, canonical raw records,
tools, files, costs, context rollups, diagnostics, recommendations, and local
session state. Deleting or rebuilding the archive does not delete the source
JSONL files.

## Automatic and explicit sync

Read commands normally sync first. `decant serve` performs a startup sync and
then watches the configured source directories.

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

| Action | Archive rows | Default reads and statistics | Later sync | Source JSONL |
| --- | --- | --- | --- | --- |
| Archive | Retained | Hidden, including effective descendants | Remains archived | Unchanged |
| Restore visibility | Retained | Visible unless an ancestor or source state still hides it | Remains visible | Unchanged |
| Delete | Selected session tree is physically removed | Excluded | Tombstones prevent resurrection | Unchanged |

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
Claude Code, Codex, or Cursor CLI session remains on disk. If the source record must also be
removed, manage it through the owning tool or delete that source file only
after deciding that losing the original transcript is intended.

Never commit a real archive, transcript, exported session, source path dump, or
fixture derived from private content. Synthetic fixtures are the only session
data allowed in this repository.

## Rebuilds and migrations

Source logs are sufficient to rebuild transcript-derived state. Supported
archives migrate to the current baseline on open; older archives are
rebuild-only. The next sync backfills persisted economics, parser enrichments,
and context rollups when required.

Costs are materialized at ingest. A rebuild uses the pricing table in the new
Decant version and can therefore change historical estimates even when the
source logs did not change.

Local state that does not come from provider logs belongs to the archive. That
includes recommendation status, session archive overrides, and deletion
tombstones.
Preserve the database before a rebuild if that state matters, and do not assume
it can be reconstructed from transcripts.

## API visibility

Default lists, full-text search, command-palette search, statistics, tools,
files, and economics exclude user-hidden sessions. Statistics operations that
accept `include_archived=true` add archived sessions back; deleted sessions and
their content remain absent.

See the Response and archive semantics section of docs/api/routes.md for the
wire behavior and [How Decant analytics work](analytics-methodology.md) for the
effect on analytical denominators.
