---
name: new-source-parser
description: Add support for a new coding-agent session format to decant. Use when adding a parser for a tool such as Cursor, Aider, or Gemini CLI, when changing src/sources/claude.ts or src/sources/codex.ts, or when session logs are parsed into the archive incorrectly.
---

# Adding a source parser

Parsers are decant's extension point (invariant 6), and the canonical
workflow is `docs/prompts/add-source.md` — read it and work through it top to
bottom. It owns the full checklist: discovery, parser rules, the capability
report the PR must include, synthetic fixtures, tests, and golden
regeneration. Its privacy rules are hard requirements, not suggestions.

Decant-side anchors while you work:

- Read `src/sources/codex.ts` first as the reference implementation, and
  `src/model.ts` for the normalized shape every parser must produce.
- Parsers return data and issues; never throw on malformed input, and never
  write to stdout/stderr (invariant 1). Output and exit-code policy belong in
  `src/cli.ts` and nowhere else.
- If the format needs a new column, that is a schema migration, and migrations
  freeze once committed. Use the `new-migration` skill.

## Gate

`bun test`, `bunx tsc --noEmit`, `bunx biome check .`, or `just check` for all
three plus the distribution smoke.
