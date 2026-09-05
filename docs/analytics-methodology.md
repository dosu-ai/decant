# How Decant analytics work

Decant derives analytics from the normalized session records already stored in
the local archive. It does not call a model or upload transcripts. This page
defines the units behind the CLI, API, UI, and reports so their numbers can be
interpreted consistently.

## Scope and dates

The `from` and `to` filters are inclusive UTC calendar dates. A session belongs
to a window according to the date prefix of its `started_at` timestamp. Invalid
date strings are ignored by the API, so callers that need a strict contract
should validate dates before sending them.

Archived and deleted sessions are excluded by default. Statistics endpoints
that accept `include_archived=true` can include user-archived sessions; deleted
sessions remain excluded. See [Archive and data lifecycle](data-lifecycle.md).

## Session source

The `source` filter scopes analytics to the client that produced a session:
`claude_code` for Claude Code, `gemini_cli` for Gemini CLI, and, for Codex, the
recorded producer metadata splits `codex_app` from `codex_cli`. That split
reads only the session's own `originator` and `source` metadata: desktop
origins (`Codex Desktop`, `codex_work_desktop`) count as the app, and CLI
origins (`source: cli`, or the legacy `codex-tui` originator) count as the
CLI. Codex sessions recorded by other producers, such as editor extensions or
scripted runs, match neither bucket; they remain visible under "All sources".
The filter describes the producing client only and never infers an account
identity, email address, or organization.

Like date filtering, a selected source describes which sessions are in scope,
not a different metric. `GET /api/metadata/session-sources` lists the source
values represented by visible sessions so the picker can omit empty ones, and
the analytics report names the selected source. Source-filtered reports omit
archive-wide insights because signals use archive-wide evidence.

## Sessions, runs, and subagents

A top-level session is a run that is not marked as a subagent. A subagent is a
nested run linked to a parent session.

- `sessions` in aggregate statistics counts top-level sessions only.
- Message, tool-call, token, and estimated-cost totals include all visible
  sessions in scope, including subagents.
- `GET /api/sessions` omits subagents as list rows by default.
  `include_subagents=true` includes them; `with_subagents=true` attaches nested
  summaries to the returned rows.
- `subagent_count` and `subagent_estimated_cost_usd` on one summary describe its
  direct children. For a complete tree, request subagents as rows and join them
  by `parent_session_id`; attached nested summaries are capped at five levels.

This distinction matters when comparing throughput with cost: a single
top-level session can coordinate many separately metered runs.

## Work type and completion labels

Work type and outcome are lightweight transcript-shape heuristics, not evidence
that a change shipped or achieved its goal. Work type starts with keywords in
the first user prompt and can fall back to the mix of file and web activity.
Outcome looks at how the main transcript ended: a normal assistant completion,
an interruption, a trailing user/tool turn, or an error result.

Use these labels to organize follow-up analysis. Do not treat `completed` as a
merged change, a passing test suite, or a successful business outcome without
joining Decant data to evidence from the system where the work landed.

## Token and cost totals

Decant preserves provider-reported input, output, cache-read, cache-creation,
and reasoning usage when the source exposes it. Claude reasoning can be
estimated by subtraction when the source does not report it directly; the API
keeps reported and estimated reasoning separate.

Gemini CLI reports usage per model turn in the Gemini API's shape, which Decant
normalizes at ingest: the reported prompt count already includes cached
content, so input is stored net of cache reads, and thought tokens are
reported outside the candidate count, so they are folded into output and also
recorded as reported reasoning.

Costs use the pricing table that existed when the session was ingested. They
are estimates of standard API token rates, not a reconstruction of a ChatGPT
subscription, Codex credits, discounts, or provider invoices. Updating
[pricing](pricing.md) does not rewrite historical rows; rebuild the archive to
re-estimate them.

## Activity buckets

Token economics assigns generation, context-window volume, tool calls,
estimated cost, and active time to four buckets:

| Bucket | What it represents |
| --- | --- |
| `context` | Reading, searching, listing, web/MCP retrieval, and read-only shell or Git commands. Unknown tools default here rather than overstating implementation. |
| `planning` | Thinking/reasoning blocks and explicit plan-management tools. |
| `code` | Structured edits and shell commands that clearly build, test, write, or otherwise mutate work. |
| `communicating` | Visible text and other non-tool, non-thinking output. |

Shell classification is deliberately conservative. Read-only commands such as
`rg`, `cat`, and `git diff` are context; mutating or unrecognized shell commands
are code. A bucket is an analytical attribution, not a provider billing field
or a quality judgment.

Generation is allocated from per-message usage when available, then by block
size when it is not. Tool-result bytes contribute to context-window volume.
Bucket costs are proportional allocations of the session's estimated input and
output cost, so they reconcile to the total but should not be read as separate
provider charges.

### Search counting

This defines the search count behind the "discovery is expensive"
recommendation signal (`signal:search-heavy`). It is separate from activity
buckets and does not change how shell commands are bucketed above. A search is
a `Grep` or `Glob` tool call, or a shell statement whose leading command is a
search binary such as `rg`, `grep`, or `find`. Compound commands are split on
`;`, `&&`, `||`, and newlines. For example, `cd src && rg handler` counts.
Pipelines are not split. A command such as `ps aux | grep node` filters output
rather than searching a repository, so it does not count.

Search binaries count only when they are the leading command. Searches wrapped
by `sudo` or `xargs`, such as `sudo grep x` and `xargs grep foo`, do not count.
Codex also records some shell activity inside a JavaScript `exec` program, and
those inner commands do not count yet. The statement splitter does not parse
shell quoting, so text such as `echo "a; grep b"` can add a false search. These
cases can make the reported shell and Codex search volume too low or too high.

## Orientation and implementation

Phases are orthogonal to activity buckets:

- **Orientation** is everything before the first detected file edit.
- **Implementation** begins with that edit and includes everything after it.
- A session that never edits a file is entirely orientation.

Structured edit tools establish the boundary directly. Shell edits use narrow,
high-confidence patterns such as `git apply`, `sed -i`, and explicit file-write
APIs. The classifier prefers missing a weak signal over moving the boundary
forward on a false positive.

## Active time and user wait

Active time is an attribution from message timestamps, not stopwatch time. The
gap between two messages is charged to the later message, split across that
message's blocks, and capped at five minutes. Gaps closed by user-authored text
are reported separately as `waiting_on_user_ms`.

Consequences:

- long idle periods do not dominate the result;
- blockless or missing-timestamp messages cannot contribute;
- wall-clock session duration can be much larger than active time;
- time estimates are best for relative comparisons, not billing or timesheets.

## Context-window occupancy and compaction

For one model call, occupancy is:

`input_tokens + cache_read_tokens + cache_creation_tokens`

It is the prompt resident in the window for that call, not cumulative token
consumption. Peak occupancy is the largest observed call. Codex logs can carry
an explicit model window. Claude and Gemini infer the window from the model
when the source does not record one, and the API marks inferred values.

Compactions come from provider boundary records. Pre- and post-compaction token
counts are preserved when the source supplies enough information; missing
values remain unavailable rather than being invented.

## Data quality signals

`unparsed_line` means Decant could not normalize a source line and is treated
as a substantive ingest issue. Other diagnostics, such as an unknown record
type or imperfect tool linkage, are informational format-drift sensors. Both
are preserved, but informational notices should not be described as data loss
without inspecting the session's issue details.

For the machine-readable field definitions, see the
[OpenAPI contract](api/openapi.yaml). For practical queries, see
[Local API recipes](api/recipes.md).
