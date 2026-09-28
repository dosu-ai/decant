---
name: schema-migration
description: Change Decant's SQLite schema (tables, columns, indexes, triggers) or force a re-derive of existing archives. Use when editing src/db.ts migrations, src/schema.sql, src/schema-manifest.ts, LATEST_SCHEMA_VERSION, or INGEST_PIPELINE_REVISION.
---

# Schema migration

The rules are AGENTS.md invariant 5 and the "Rebuilds and migrations" section
of `docs/data-lifecycle.md`. Read both before editing.

## Rules

- A migration is frozen once it is on `main`: someone may already have opened
  an archive with it. Never edit an existing `if (current < N)` block; add a new
  one, even to fix a mistake in the previous one.
- Bump `LATEST_SCHEMA_VERSION` in `src/db.ts`. Refer to that constant in docs
  instead of writing the number.
- Guard each statement so a partially-migrated or operator-modified archive
  still converges (`IF NOT EXISTS`, `hasTable`, `hasColumn`), and stamp the new
  version in `schema_migrations` inside the same block.
- `src/schema.sql` is the effective baseline for a fresh archive. Apply the same
  change there so a fresh archive and a migrated one produce the same
  `buildSchemaManifest` fingerprint; `src/schema-manifest.ts` changes only if
  the manifest needs to learn a new object kind.
- Bump `INGEST_PIPELINE_REVISION` in `src/ingest.ts` only when unchanged source
  files must be re-derived. The next sync then backfills them once and later
  syncs stay idempotent. A pure index or constraint change does not need it.
- Unsupported older archives are rebuild-only; do not add upgrade paths below
  the baseline.

## Tests

- `test/db.test.ts`: migrate a previous-version archive and compare it with a
  fresh one; assert any query plan the new index exists for.
- Run the migration against a scratch copy of a large archive and time it
  (`DECANT_DB=<copy>`). Never point a migration at `~/.decant/decant.db`.

## Docs

Update `docs/data-lifecycle.md` when archive state, sync, or migration behavior
changes, and `docs/architecture.md` if module boundaries move.
