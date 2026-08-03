---
name: new-source-parser
description: Add support for a new coding-agent session format to decant. Use when adding a parser for a tool such as Cursor, Aider, or Gemini CLI, when changing src/sources/claude.ts or src/sources/codex.ts, or when session logs are parsed into the archive incorrectly.
---

# Adding a source parser

Parsers are decant's extension point. A new source tool means a new file in
`src/sources/`, never a special case threaded through ingest. Read
`src/sources/codex.ts` first as the reference implementation, and `src/model.ts`
for the normalized shape every parser must produce.

## Steps

1. **Write `src/sources/<tool>.ts`.** Export a parse function that takes the raw
   session content and returns a `ParsedSession`. Normalize into the shared types
   from `src/model.ts`, which are `NormalizedSession`, `NormalizedMessage`,
   `NormalizedBlock`, `TokenUsage`, and `Role`.

2. **Report problems as issues, do not throw.** Push onto
   `ParsedSession["issues"]` so one malformed session cannot fail a whole sync.
   Real logs are messy and a parser that throws makes the archive unbuildable.

3. **Stay print-free.** Parsers return data and `Result`-style errors. Output and
   exit-code policy belong in `src/cli.ts` and nowhere else.

4. **Write synthetic fixtures only.** Never copy a real transcript into the repo.
   `~/.claude` and `~/.codex` hold private conversations, and `test/golden/` must
   stay generated from synthetic fixtures. Hand-write the smallest JSONL that
   exercises the format, following the helpers in `test/codex.test.ts`.

5. **Add tests at both levels.** A parser test in `test/<tool>.test.ts` for
   shape and edge cases, plus ingest and query coverage proving a session lands
   in the archive and comes back out of search and stats.

6. **Wire discovery.** Add the source directory resolution and its environment
   override alongside `DECANT_CLAUDE_DIR` and `DECANT_CODEX_DIR`, then document
   the new variable in AGENTS.md and README.md.

7. **Regenerate goldens** once behavior is settled.

   ```bash
   bun run scripts/regen-goldens.ts --i-reviewed-the-diff
   ```

   The flag is deliberate. Read the resulting diff before committing it, because
   an unreviewed golden update hides a real behavior change.

8. **Check cost handling.** Costs are computed at ingest by `cost::estimateCost`
   and stored on the session row. If the tool reports usage differently, confirm
   the token fields map correctly, since editing pricing later does not rewrite
   historical rows.

## Schema changes

If the format needs a new column, that is a migration, and migrations freeze once
committed. Use the `new-migration` skill.

## Gate

`bun test`, `bunx tsc --noEmit`, `bunx biome check .`, or `just check` for all
three plus the distribution smoke.
