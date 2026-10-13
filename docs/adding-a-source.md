# Add a source parser

Decant's source parsers turn coding-agent session files into one normalized
archive. A new source must preserve privacy, tolerate format drift, and report
which analytics its native format can support.

Use this checklist when adding support for another coding-agent CLI.

## Protect transcript privacy

- Inspect aggregate shapes only, such as record-type names, key sets, value
  types, and counts. Do not print, quote, or commit transcript prose, source
  paths, tokens, credentials, or environment values.
- Write every fixture by hand with invented content such as `"hello"`,
  `/tmp/example`, and `example-model`. A redacted or edited real transcript is
  not a synthetic fixture. When ingest reads files near a session's directory,
  as OpenCode config lookup does, use a directory no user can create, such as
  `/decant-fixture/example`, so golden runs never read the machine's own files.
- Parity checks against a private session store must report counts and shape
  mismatches only, never content.

## Add the source

1. **Discovery** teaches `discover()` in `src/ingest.ts` where session files
   live and which sidecars to exclude. Add a source-directory environment
   override and document it in `README.md`. A database-backed source (see
   `src/sources/opencode-store.ts`) adds a read-only store module that lists
   sessions with a per-session change key and loads one session's rows; each
   session is registered as a virtual source `<database>#<session id>` with
   the key in `ingest_source.hash`, and the sync loop handles it before the
   file-open path. When the tool has changed its storage layout, one store can
   list sessions from each layout: tag each source ref with its format, give
   each layout's change key a distinct prefix so a session that moves between
   layouts is re-ingested, decide in discovery which copy of a session wins,
   and keep one pure parser per layout.
2. **Parser** adds `src/sources/<tool>.ts` and returns a `ParsedSession`.
   Parsers are pure and print-free, returning data and issues without throwing
   on malformed input or writing to stdout or stderr.
3. **Tool ID** adds a lowercase snake-case wire value to `TOOLS` in
   `src/model.ts`. It is persisted in SQLite, so choose a stable value.
4. **Watch root** extends `watchDirs()` in `src/watch.ts` so `decant serve`
   notices new sessions.
5. **Capability report** includes the table below in the pull-request
   description.

## Capability report

| Capability | Value for this source |
| --- | --- |
| Per-message token usage | reported exactly / partially / absent |
| Cache token split | reported / absent |
| Model ID per session | reported / inferred / absent |
| Reasoning tokens | reported / inferred / absent |
| Timestamps | per record / per session / absent |
| Tool call/result linkage | by ID / by adjacency / absent |

Decant can only report economics where usage data exists. Costs are calculated
with `estimateCost` in `src/cost.ts` and stored at ingest. Every sync
reconciles stored costs with current rates, so a pricing change reprices
historical rows without a rebuild. If a source has no usage data, cost must be
unavailable rather than zero.

## Parser behavior

- For a malformed line, append an `unparsed_line` issue and continue parsing
  the file.
- Count unrecognized record types and emit one `unknown_record_type` issue per
  distinct type. This is Decant's format-drift signal, so do not silently
  ignore unknown records.
- Call `linkageIssues(session)` from `src/diagnostics.ts` before returning.
- Normalize roles to `user | assistant | system | tool | other` and blocks to
  `text | thinking | tool_use | tool_result | web_search | image | other`.
- Keep each canonical source record in `message.raw` so the archive remains
  full fidelity when the normalized model is lossy.
- Normalize MCP tool names to `mcp__<server>__<base>` so `classifyTool` in
  `src/tools.ts` can recognize them.
- When a code-execution tool records the calls its program made (OpenCode's
  `execute`), list them in `innerToolCalls` on the wrapper's `tool_use` block,
  named like direct calls, with a tool-use ID derived from the wrapper's.
  Ingest writes one tool-call row per inner call without adding transcript
  blocks.
- Date each message when the work it records finished, because active time
  charges the gap before a message to that message's blocks. If a tool call
  started at a time other than its message's, set `calledAt` on its
  `tool_use` block; ingest dates and times the call from it.
- Emit one session per source path. Per-session diagnostics join on the source
  path and would be misattributed if one path produced several sessions; a
  database that holds many sessions therefore gets one virtual path per
  session.
- For a database-backed source, take rows as plain objects (the store does the
  I/O) and keep the parser pure; use the row's sequence number as the issue
  `lineNo`.

Use `src/sources/codex.ts` as the reference parser and `src/model.ts` for the
normalized shape.

## Tests and fixtures

Add all of the following:

1. `test/<tool>.test.ts` covering the happy path, malformed lines, unknown
   record types, tool call/result linkage, and usage totals.
2. Hand-written fixtures under `fixtures/<tool>/`, including variants for each
   meaningful parser branch.
3. Discovery and ingest coverage in `test/ingest.test.ts`.
4. The new fixture paths in `test/golden/meta.json`.
5. The source directory in both fixture stagers: `stageFixtures()` in
   `scripts/regen-goldens.ts` and its counterpart in
   `test/cli-golden.test.ts`.

Regenerate goldens only after the focused tests pass:

```sh
bun run scripts/regen-goldens.ts --i-reviewed-the-diff
```

Review the generated diff before committing it. An unreviewed golden update can
hide a parser regression.

## Definition of done

- `just check` passes.
- The pull request includes the capability report.
- Every committed fixture is demonstrably synthetic.
- A private parity run reports only aggregate totals, including sessions
  parsed, sessions with issues, issue counts by code, and unknown record types.
