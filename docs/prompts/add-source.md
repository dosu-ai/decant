# Add a source: parser for a new coding-agent CLI

You are adding support for a new session-transcript source to Decant. Work
through this document top to bottom. The privacy rules are hard requirements,
not suggestions.

## Privacy rules (read first)

- Real transcripts are private. When you inspect the tool's native session
  store, extract **aggregate shapes only**: record-type names, key sets, value
  types, counts. Never print, quote, or commit transcript prose, file paths
  from another person's machine, tokens, or environment values.
- Fixtures are **synthetic**: write them by hand from the shapes you observed,
  with invented content ("hello", "/tmp/example", "example-model"). A fixture
  that started life as a real transcript is a rejected PR, even if edited.
- Parity checks against your own real store report **counts and shape
  mismatches only** (see step 6), never content.

## What Decant needs from a source

1. **Discovery** — where session files live and which filenames are sessions
   (`src/ingest.ts: discover()`); non-session sidecars are excluded by name,
   like Codex's `session_index.jsonl` and Claude's `journal.jsonl`.
2. **A parser** — `src/sources/<tool>.ts` exporting
   `parse<Tool>Session(sourceSessionId: string, content: string, ...): ParsedSession`.
   Pure and print-free: return data and issues; never throw on malformed
   input; never write to stdout/stderr (invariant 1).
3. **A tool id** — add the wire string to `TOOLS` in `src/model.ts`
   (lowercase snake_case; it is stored in SQLite and never reworded).
4. **A watch root** — extend `watchDirs()` in `src/watch.ts` so `serve`
   notices new sessions.
5. **A capability report** — fill in the table below in your PR description.

## Capability report (required in the PR)

| capability | value for this source |
|---|---|
| per-message token usage | reported exactly / partially / absent |
| cache token split | reported / absent |
| model id per session | reported / inferred / absent |
| reasoning tokens | reported / inferred / absent (`REASONING_SOURCES`) |
| timestamps | per record / per session / absent |
| tool call/result linkage | by id / by adjacency / absent |

Decant promises economics only where usage data exists. If this source
reports no usage, cost must surface as unavailable, not zero — say so in the
PR so the maintainers wire the presentation tier deliberately.

## Parser rules

- Malformed line → push `{code: "unparsed_line", lineNo, error, rawLine}`
  onto issues and continue. Never fail the file.
- Record types you do not recognize → count them and emit one
  `unknown_record_type` issue per distinct type (see
  `src/sources/claude.ts` for the pattern). This is Decant's format-drift
  sensor; do not silently swallow unknowns.
- Call `linkageIssues(session)` from `src/diagnostics.ts` before returning.
- Normalize into `NormalizedSession` (`src/model.ts`): roles map onto
  `user | assistant | system | tool | other`; blocks onto
  `text | thinking | tool_use | tool_result | web_search | image | other`.
  Keep the raw record on `message.raw` (canonical JSON) — the archive is
  full-fidelity even where the normalized model is lossy.
- MCP tool names follow `mcp__<server>__<base>`; if the source spells them
  differently, normalize in the parser so `classifyTool` (`src/tools.ts`)
  classifies them — see the Codex handling for the precedent.
- Emit exactly one session per source file. Per-session diagnostics join on the session's source path, so a parser that yields multiple sessions from one file would mis-attribute every issue count for that file.

## Tests (all required)

1. Parser tests: `test/<tool>.test.ts` — happy path, malformed line,
   unknown record type, tool call/result linkage, usage totals.
2. Fixtures: `fixtures/<tool>/sample.jsonl` (+ variants your parser branches
   on), synthetic per the privacy rules.
3. Ingest tests: extend `test/ingest.test.ts` discovery coverage.
4. Goldens: new fixtures must appear in `test/golden/rows/*.json` and
   `test/golden/meta.json`'s fixture list. Goldens are hand-maintained —
   mirror the existing rows' field layout exactly; there is no regeneration
   script.

## Definition of done

`bun test && bunx tsc --noEmit && bunx biome check .` green, plus a parity
run over your own real store: parse every session, then report — in
aggregate only — sessions parsed, sessions with issues, issue counts by
code, and any record type your parser had to mark unknown.
