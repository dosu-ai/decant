<!--
Read CONTRIBUTING.md first. Solve one problem per pull request. Use a
Conventional Commit title in plain language, such as
"fix: keep forked Codex subagents out of their parent sessions".
Keep every heading below, including when an agent writes the description.
-->

## Problem

<!-- What is wrong or missing, in a sentence or two. Link the issue it closes
(`Closes #123`). New sources and new UI features need an issue or discussion
first; see CONTRIBUTING.md. -->

## Change

<!-- How this fixes it. When the diff spans parsers, ingest, the API, and the UI,
say why each part is needed for the same fix. -->

## Verification

<!-- The focused tests or manual checks you ran and what you observed. State
anything you could not check. "Tests pass" alone is not enough; CI already runs
the full gate.

For UI changes, attach before and after screenshots, and a short recording when
motion or interaction matters. Upload them with the pull request
(`gh pr edit --attach` or drag and drop). Never commit PR-only images. -->

## Archive schema

The baseline is `LATEST_SCHEMA_VERSION` in `src/db.ts`. Check one:

- [ ] This change does not touch the archive schema.
- [ ] This change adds a migration. Committed migrations are unchanged, and the Change section says what happens to existing archives.

Check if it applies:

- [ ] This change bumps `INGEST_PIPELINE_REVISION`, so the next sync re-derives every source once.

## Docs and privacy

- [ ] Docs that describe the changed behavior are updated (see "Documentation expectations" in AGENTS.md), or nothing user-visible changed.
- [ ] Every fixture and golden in this diff is hand-written synthetic data. Nothing comes from a real transcript or archive.

<!-- If an agent wrote the change, end with the model and harness, for example
"Written with Claude Opus 5.5 in Claude Code". -->
