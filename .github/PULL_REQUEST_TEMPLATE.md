## Summary

<!-- What changed, in one or two sentences. -->

## Why

<!-- The problem this solves. Link the issue it closes: `Closes #123`. -->

## Validation

<!--
What you ran and what it reported. Paste output for anything that failed or that
you decided to accept. Screenshots or a short clip for UI changes.
-->

- [ ] `just check` passes (`bun test`, `bunx tsc --noEmit`, `bunx biome check .`, distribution staging smoke).
- [ ] New behavior has focused tests. No existing test was weakened or deleted to make this pass.

## Archive schema

The baseline is `LATEST_SCHEMA_VERSION` in `src/db.ts`. Check one:

- [ ] This change does not touch the archive schema.
- [ ] This change bumps the schema. It ships the migration, and the summary above says what happens to archives created before it.
