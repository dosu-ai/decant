---
name: add-source
description: Add or extend a Decant source parser for another coding-agent CLI's session logs. Use when adding a new tool under src/sources/, changing how an existing parser normalizes records, or touching discovery, watch roots, or parser fixtures and goldens.
---

# Add a source parser

The checklist lives in `docs/adding-a-source.md`. Read it in full before
editing; this skill only lists the steps that are easy to miss.

## Privacy first

- Never print, quote, or commit transcript content from `~/.claude`,
  `~/.codex`, or any other real session store. Inspect record shapes with
  aggregate counts only (types, key sets, value types).
- Every fixture under `fixtures/<tool>/` is hand-written with invented content.
  An edited real transcript is not synthetic.

## Touchpoints

1. `discover()` in `src/ingest.ts` (where files live, which sidecars to skip)
   plus a source-directory env override documented in `README.md`.
2. `src/sources/<tool>.ts`: pure and print-free, returns a `ParsedSession`,
   turns malformed lines into `unparsed_line` issues and unknown record types
   into one `unknown_record_type` issue per type, calls `linkageIssues`.
3. The tool ID in `TOOLS` in `src/model.ts` (persisted; choose it once).
4. `watchDirs()` in `src/watch.ts`.
5. The capability table from the doc, filled in for the pull request.

## Tests and goldens

- Parser tests in `test/<tool>.test.ts`, ingest coverage in
  `test/ingest.test.ts`, fixture paths in `test/golden/meta.json`, and the
  fixture directory in both stagers (`scripts/regen-goldens.ts` and
  `test/cli-golden.test.ts`).
- Regenerate goldens only after focused tests pass, then read the whole diff:
  `bun run scripts/regen-goldens.ts --i-reviewed-the-diff`.
  A golden change in an existing source is a regression until explained.

## Done

`bun test`, `bunx tsc --noEmit`, and `bunx biome check .` pass, then
`just check`. Use `DECANT_DB=<scratch> ... --no-sync` for manual runs so the
real archive is never touched.
