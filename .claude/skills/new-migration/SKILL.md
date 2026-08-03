---
name: new-migration
description: Add or change decant's SQLite schema safely. Use when adding a column, table, index, or FTS change to the archive, when bumping LATEST_SCHEMA_VERSION, when a SchemaDriftError appears on open, or when reviewing a change that touches src/db.ts, src/schema.sql, or src/schema-manifest.ts.
---

# Adding a schema migration

Read `src/db.ts` around the newest migration before writing anything. The
archive baseline is v21 and the current value lives at `src/db.ts:24`.

## The rule that matters most

**A migration is frozen the moment it is committed to a branch.** A dogfooding
archive may already have run it, and re-running an edited version is not
possible. If review asks for a change to a migration that is already committed,
add a new version rather than editing the old one. Never edit a committed
migration, even on an unmerged branch.

This is not theoretical. Migration 11 was once run in an uncommitted form
against the live archive, which left a stray `session.context_compaction_count`
column that the fingerprint gate then rejected on open. Repairing it took a
guarded migration of its own rather than a rebuild.

## Steps

1. **Write the migration guarded.** Follow the existing style in `src/db.ts`.
   Use the `hasTable` and `hasColumn` helpers so a partially migrated archive
   converges instead of throwing, then stamp it.

   ```ts
   if (version < 22) {
     if (hasTable(db, "session") && !hasColumn(db, "session", "my_column")) {
       db.exec("ALTER TABLE session ADD COLUMN my_column INTEGER");
     }
     db.query(
       "INSERT INTO schema_migrations (version, applied_at) VALUES (22, datetime('now'))",
     ).run();
   }
   ```

   `assertSchemaMatchesBaseline` runs after the migration chain, so a migration
   that leaves the database disagreeing with `src/schema.sql` fails loudly rather
   than shipping drift.

2. **Bump `LATEST_SCHEMA_VERSION`** at `src/db.ts:24`.

3. **Update `src/schema.sql`** so it describes the effective DDL with migrations
   1 through `LATEST_SCHEMA_VERSION` already applied, and bump its header
   comment. `src/schema.sql` is the fresh-database path, the migration is the
   upgrade path, and the two must agree.

4. **Check `src/schema-manifest.ts`** if the change affects the fingerprint.
   Drift is detected by comparing a live database against the manifest, so a
   mismatch here is what produces a `SchemaDriftError` for users.

5. **Add a focused test** in `test/db.test.ts`. Cover the upgrade from the
   previous version and the fresh-create path. If an older test rewinds to a
   version below yours, check that its range stays contiguous.

6. **Update the baseline note in AGENTS.md** under Project invariants if the
   baseline moves.

## Never do this

- Do not add broad forward migrations from pre-v8 archives. Those are
  rebuild-only by decision, so delete and re-ingest.
- Do not point schema experiments at the real archive. Use a scratch database,
  `DECANT_DB=/tmp/scratch.db` together with `--no-sync`, or the watcher will
  fill it from the real `~/.claude` and `~/.codex`.
- Do not rebuild a live archive to dodge a migration. Manual recommendation
  state and sessions whose source logs were pruned exist only in the database.

## Gate

`bun test`, `bunx tsc --noEmit`, `bunx biome check .`, or `just check` for all
three plus the distribution smoke.
