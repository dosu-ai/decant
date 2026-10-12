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

Tool and MCP aggregates follow the same rule, so a call made just after midnight
counts on the day its session started. The Tools page summary cards (total
calls, error rate, median and p95 elapsed, top tool) share that scope with the
tool and MCP tables. The page's tool and server filters narrow the cards, while
the "Errors only" and minimum-elapsed filters narrow only the call list. The
call list itself is the exception to the session rule: it filters each call by
its own timestamp, so a call appears on the day it ran.

The live "today" totals are another exception. They cover the server's local
calendar day, converted to a UTC range before it is compared with
`started_at`.

Archived and deleted sessions are excluded by default. Statistics endpoints
that accept `include_archived=true` can include user-archived sessions; deleted
sessions remain excluded. See [Archive and data lifecycle](data-lifecycle.md).

## Sessions, runs, and subagents

A top-level session is a run that is not marked as a subagent. A subagent is a
nested run linked to a parent session.

- `sessions` in aggregate statistics counts top-level sessions only. So do the
  hour and weekday histograms and the per-model daily sparklines, so each one
  sums to the matching `sessions` count.
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
Codex `developer` messages and the AGENTS.md or environment context Codex
injects as a user message are system rows, so they are neither the first prompt
nor a turn.
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

Claude journal records can split one API message across content blocks and
repeat its usage on each record. Decant counts that usage once, grouping by
`requestId` or `request_id`, with `message.id` as the fallback. It retains the
usage snapshot with the largest output count and uses the same grouping for
reasoning estimates. Records with neither identifier are counted separately.
All content blocks remain in the transcript. Stream `result` usage, when
present, takes precedence for session totals.

Gemini CLI reports usage per model turn in the Gemini API's shape, which Decant
normalizes at ingest: the reported prompt count already includes cached
content, so input is stored net of cache reads, and thought tokens are
reported outside the candidate count, so they are folded into output and also
recorded as reported reasoning.

OpenCode records `input`, `output`, `reasoning`, `cache.read`, and
`cache.write` counts on each assistant step. Decant stores input as reported,
output with reasoning included (reasoning is also recorded as reported), cache
reads as cache reads, and cache writes as cache creation. OpenCode 2.x, and
1.x from v1.3.16 on, record output without reasoning, so Decant stores
`output + reasoning`. Releases up to v1.3.15 recorded output that already
included reasoning, so Decant does not add reasoning again; OpenCode's recorded
cost for those steps charges reasoning twice, which matters only where Decant
falls back to the reported cost. A step's recorded `total` decides which
convention it follows. Without one, the OpenCode version recorded on the
session decides. OpenCode writes that version once, when the session is
created, so a session created before v1.3.16 and resumed on a later release
can be misclassified for steps that carry no `total`. Preview builds record a
version of the form `0.0.0-<channel>-<YYYYMMDDHHmm>`; Decant compares that
build time with the v1.3.16 release (2026-04-06).

OpenCode 1.x keeps steps as parts of a message, and the message's own token
counts hold only its last step. Decant sums the message's per-step
(`step-finish`) usage instead, and counts one step per message, as 2.x does
per row. A 1.x message with no per-step records uses its own counts, and one
that recorded neither tokens nor cost (an unfinished request) has no usage.

Compaction steps carry their own usage and are counted; `opencode stats` does
not count them on a local install, so Decant can read slightly higher. In 1.x a
compaction is a request message plus the summary that answers it; Decant
stores the pair as one compaction record carrying the summary's usage, as it
does for a 2.x compaction row. OpenCode 2.x session totals also include title
generation, which never appears in a message row, so Decant's per-session
totals can read slightly lower than OpenCode's.

A fork copies its parent's messages with their original creation time.
Decant skips every message older than its session, so forked history is
counted once, in the parent. 2.x records the fork link, but 1.x records none,
and sessions OpenCode migrated from 1.x keep none, so the timestamp is the
only signal for them. `opencode stats` skips inherited rows only for sessions
with a fork link, so for a fork migrated from 1.x it counts the parent's
history again and reads higher than Decant. Decant differs from it here on
purpose. Messages past a revert point stay counted until OpenCode deletes them
at the next prompt; OpenCode's own migration keeps them too. A 1.x message
that holds only a subtask (a `/command` run as a subagent) is kept as a system
message, `Subtask (<agent>): <description>`, so the turn stays visible.

When OpenCode upgrades from 1.x it migrates sessions into its 2.x tables.
Decant reads migrated rows with the 1.x rules that still apply to them: the
session's version decides the reasoning convention (the migration does not
copy `total`), `filePath` tool inputs produce file references, and `task`
calls link subagents. The migration copies each message's last-step token counts only, so
a migrated 1.x message that took several steps (a retry within one request)
reads lower than the original. When a 1.x binary keeps writing a session after
the migration, its 1.x copy is newer, and Decant reads that copy with exact
per-step usage.

Costs are priced per API request, not per session. Each billed request is
charged at the model that served it and at its price tier: standard, fast mode,
or a long-prompt surcharge (see [pricing](pricing.md)). A session that switched
models, such as an Opus session that ran some requests on another Opus version,
is the sum of each model's share. Locally generated Claude records labeled
`<synthetic>`, and requests with no recorded model, are charged to the
session's model. When a session's per-request usage does not add up to its
totals, for example when a stream `result` record disagrees with the journal,
the whole session is priced at its model.

When Decant has no rate for a model, the cost OpenCode recorded for those
requests is used instead and the session's `cost_source` is `reported` (or
`mixed` when only some of its model rows fell back). A recorded cost of zero
is never used: subscription routes such as the GLM Coding Plan record zero,
which is a placeholder, not a price. A reported cost has no input/output
split; token-economics totals carry it as `reported_cost_usd`, and activity
buckets receive it by context-window share.

For Claude Code, a session's `model` is the model that served most of its
requests; other sources use the model their session metadata records. The model
breakdown counts each session once, under that label, but splits tokens and
estimated cost by the model behind each request. A model can therefore show
tokens and cost with zero sessions. Each session's stored cost is divided among
its models in proportion to what their requests cost at current rates, so the
breakdown sums to the archive total. Reasoning tokens are recorded per session
and stay with the session's label.

Costs use the current [pricing table](pricing.md). Every sync reconciles
stored session and activity costs, so historical estimates can change when
rates or pricing logic change. These are estimates of standard API token rates,
not a reconstruction of a ChatGPT subscription, Codex credits, discounts, or
provider invoices. Usage from unsupported models is retained, but aggregate
dollar totals exclude their unknown costs.

## Activity buckets

Token economics assigns generation, context-window volume, tool calls,
estimated cost, and active time to four buckets:

| Bucket | What it represents |
| --- | --- |
| `context` | Reading, searching, listing, web/MCP retrieval, read-only shell or Git commands, and messages from other agents. Unknown tools default here rather than overstating implementation. |
| `planning` | Thinking/reasoning blocks and explicit plan-management tools (`TodoWrite`, Claude Code task-list tools, Codex `update_plan`). |
| `code` | Structured edits, shell commands that clearly build, test, write, or otherwise mutate work, browser and desktop actions, REPL code, and note writes. |
| `communicating` | Visible text and other non-tool, non-thinking model output, plus questions to the user (`AskUserQuestion`, Codex `request_user_input`). |

Shell classification is deliberately conservative. Read-only commands such as
`rg`, `cat`, `sed -n`, and `git diff` are context; mutating or unrecognized
shell commands are code. Decant judges a compound command by every part, not by
its first word:

- It splits on `;`, `&&`, `||`, a backgrounding `&`, newlines, and pipes,
  ignoring separators inside quotes and `$(...)`, and the command is context
  only when every part is read-only. Heredoc bodies are data, so the command
  that reads them decides.
- `cd`, `export`, variable assignments, and loop keywords such as `for` and
  `done` change only the shell's state, so they never decide the bucket.
  `cd repo; grep -n x src | head` is context. Waiting (`sleep`,
  `gh pr checks --watch`) is code, because an agent waits on a build, a test
  run, or CI, and that time belongs to the work.
- Wrappers are classified by the command they run: `env X=1 git push`,
  `timeout 60 bun test`, `xargs rm`, `bash -lc "<script>"`, and the body of
  `$(...)`.
- One mutating part makes the whole command code, and so does an output
  redirect to a file (`>`, `>>`, `2>`, `&>`, `>&file`); `2>&1` and
  `>/dev/null` don't count.
- Some commands are read-only only with certain arguments. `git` reads through
  global options (`git -C dir log`), and `branch`, `tag`, `remote`, and
  `config` read only when they list or get. `gh pr view`, `gh run view`, and
  `gh api` GET requests read; `gh pr merge` and `gh api -X POST` write.
  `kubectl get`, `docker compose logs`, `find` or `fd` without `-delete` or a
  mutating `-exec`/`-x`, `sed` without `-i` or a `w`/`e` command, and
  `sqlite3 -readonly db '<sql>'` without `VACUUM INTO` or a file-writing
  dot-command read. SQL piped or fed to `sqlite3` on stdin is not visible, so
  it counts as code. A remote `curl` GET that prints its response is
  retrieval; a download, a request body, or a probe of a local dev server is
  code.

Browser, desktop-control, and REPL tools (Playwright, Claude in Chrome, computer
use, and JavaScript REPL MCP servers) split by what they do. Looking at a page
or screen (snapshots, screenshots, page text, console and network logs, tab
lists, `find`) and going somewhere (`navigate`, `wait`) is context. Sending
input or running code is code: clicks, typing, key presses, form fills,
selects, drags, hovers and mouse moves, scrolling, uploads, dialog handling,
resizing, `evaluate` and other in-page JavaScript, and every REPL call. Hover
counts as input because it fires page handlers and opens menus. Batch tools are
code when any action they carry is. Other MCP tools keep the context default.

Agent orchestration (`Agent`/`Task`, `SendMessage`, Codex `collaboration__*`,
`SubagentHandback`) stays in context: the parent reads what the other agent
reports. Writing a note or checkpoint (Codex `notes__write_file` and
`notes__append_to_file`, Obsidian `obsidian_append_content`, Dosu
`write_knowledge`) is code, but it is the agent's memory rather than the work
product, so it does not mark the first edit.

A bucket is an analytical attribution, not a provider billing field or a
quality judgment.

Recent Codex CLI versions run most actions through one `exec` tool. Its input
is a JavaScript program that calls `tools.exec_command`, `tools.apply_patch`,
`tools.update_plan`, MCP tools, and similar. Decant classifies each inner call
like the tool it names:

- The whole call takes the strongest inner bucket (code, then planning, then
  communicating, then context), so a program that reads a file and then patches
  it counts as code.
- Tool examples inside JavaScript strings, regex literals, or comments do not count as calls.
  Calls inside template interpolations do count.
- An `exec_command` whose command is assembled at runtime, rather than written
  as a literal, is treated like an unrecognized shell command, which is code.
- A program that calls no tools or cannot be parsed stays in context.
- `write_stdin`, which polls or answers a running `exec_command`, is code:
  the commands agents leave running are nearly always builds and test runs.

Acorn parses these programs for static tool-call inspection. Decant does not
execute the JavaScript or resolve variables, branches, or tool aliases.
Raw programs and JSON-encoded programs or `{input: ...}` objects follow the
same attribution rules.

OpenCode 2.x runs MCP tools from a JavaScript program passed to its `execute`
tool, and records each call the program made. Decant keeps `execute` as the
model's tool call and adds one tool call per recorded inner call. An inner
call to `<server>.<tool>` is an MCP call named `mcp__<server>__<tool>`, exactly
as a direct call to that server is. OpenCode writes `<server>` with the same
`[^a-zA-Z0-9_-]` to `_` replacement it applies to direct MCP tool names, so
both forms of a call share one `mcp_server`. Inner calls with no namespace
(`search`) or in the `opencode` namespace are OpenCode built-ins and keep
their recorded name. Any other namespace is treated as an MCP server, so a
plugin that adds its own namespace to code mode would count as MCP. OpenCode
1.x has no `execute` tool and calls MCP tools directly as `<server>_<tool>`,
which Decant names `mcp__<server>__<tool>` like a 2.x direct call.

Inner calls are tool-call rows, so these numbers count both the `execute`
call and each inner call:

- `decant tool stats` and `decant mcp stats`, and `GET /api/tools/usage` and
  `GET /api/tools/mcp-usage`.
- The Dosu MCP call counters on sessions.
- `tool_calls` in `decant stats` and in token-economics buckets.
- The activity report's "Tool calls" figure and its tool table.
- A session report's tool table, so it can sum to more than that session's
  "Tool calls" total below.

These follow transcript blocks instead, so an `execute` call counts once
however many inner calls it made:

- A single session's "Tool calls" total (session detail and the session
  report), which counts `tool_use` blocks.
- A session's `error_count`, which counts failed result blocks.

Each inner call takes its own error status and input, but OpenCode records
only the program's combined output, so an inner call has no result, output
size, or duration; the `execute` call carries the output's context-window
volume once. An inner call that was still `running` when the program ended
has no error status either. Inner calls add no transcript blocks, so search
and transcripts show the program and its output once.

Generation is allocated from per-message usage when available, then by block
size when it is not. Claude Code journals one API response as a record per
content block (thinking, text, each tool call) that share the API message id,
so the response's output is split across all of those records' blocks: the
visible blocks keep their size, and the remainder is planning when the response
has a thinking block. Time is not regrouped, because each record is written when
its block finishes, so the gap before a record is the time that block took.
Output with no visible block to carry it, such as an
assistant record whose content is empty, still counts as generation and goes
to `communicating`. Tool-result bytes contribute to context-window volume, and
so does the text of a message from another agent (a Codex `agent_message`),
which the model reads the way it reads an Agent or SendMessage result.

When a source repeats a tool-call ID, calls and results pair one-to-one in
occurrence order. An unmatched call has no result volume, outcome, or duration;
it does not borrow the last result of another call with the same ID. Parser
diagnostics still report repeated IDs and surplus results, and the raw blocks
remain in the transcript.

Some kept records are neither model output nor a tool call:

- A message from another agent, or compacted history, is input the model
  reads, so its time is context.
- An image or document the user attaches is part of the user's turn.
- Instructions the harness injects, such as Codex `developer` messages and
  the AGENTS.md and environment block Codex sends as a user message, are
  stored as role `system`. The gap before one closes on the next message
  instead, so it counts toward the user's prompt or the model's next step.
- CLI notices, record types a parser keeps as role `other` without
  recognizing them, and model-fallback notices never reach the model. They
  carry no generation, window volume, or time.

Bucket costs are proportional allocations of the session's estimated input and
output cost, so they reconcile to the total but should not be read as separate
provider charges. Archive and date-range totals split each session's cost by
that session's own activity and then add the sessions up, so an archive's
bucket costs always equal the sum of its sessions' bucket costs.

Some dollars have no activity to follow. Output cost from a session with no
generation goes to `communicating`, since model output without a tool call or
thinking block is what that bucket holds. Input cost from a session with no
generation or window volume goes to `context`, the same default unknown work
gets, rather than overstating implementation. These dollars take the phase
split of the session's window volume, and a session with no recorded activity
is orientation.

Token counts and active time are rounded once per total. Each total is then
apportioned to buckets by largest remainder, and each bucket to its phases the
same way. Buckets add up to the total, and a bucket's phases add up to the
bucket. Costs are not rounded.

The API returns `cost_share` unrounded. The UI's whole-number cost and time
percentages use largest-remainder rounding, so each column adds up to exactly
100% instead of drifting to 99% or 101%.

### Search counting

This defines the search count behind the "discovery is expensive"
recommendation signal (`signal:search-heavy`). It is separate from activity
buckets and does not change how shell commands are bucketed above. A search is
a `Grep` or `Glob` tool call, or a shell statement whose command is a search
binary such as `rg`, `grep`, or `find`, or `git grep`. Statements are split the
same way as for activity buckets, outside quotes and heredoc bodies, so
`cd src && rg handler` counts once and `rg 'a;b' src` is one search. The command
is found the same way too, past variable assignments, `env`, `timeout`,
`git -C dir`, and a `bash -lc "<script>"` wrapper.

Only the first stage of a pipeline counts. A command such as
`ps aux | grep node` or `ls | xargs grep foo` filters or fans out another
command's output rather than searching a repository, so it does not count, and
neither does a search wrapped by `sudo`. Shell commands inside a Codex `exec`
program count like any other shell statement when the command is a literal
string. Commands assembled at runtime are invisible to the count. These cases
can make the reported shell and Codex search volume too low.

## Orientation and implementation

Phases are orthogonal to activity buckets:

- **Orientation** is everything before the first detected file edit.
- **Implementation** begins with that edit and includes everything after it.
- A session that never edits a file is entirely orientation.

Structured edit tools establish the boundary directly, including an
`apply_patch` call inside a Codex `exec` program. Shell edits use narrow,
high-confidence patterns such as `git apply`, `sed -i`, and explicit file-write
APIs (Node `fs.writeFileSync`, Python `open(..., "w")`, and pathlib
`Path.write_text`/`write_bytes`). The classifier prefers missing a weak signal
over moving the boundary forward on a false positive.

## Active time and user wait

Active time is an attribution from message timestamps, not stopwatch time. The
gap between two messages is charged to the later message, split across that
message's blocks, and capped at five minutes. Gaps closed by user-authored text
are reported separately as `waiting_on_user_ms`, including the share of an
image or document attached to that prompt. A question the model asks through a
tool (`AskUserQuestion`, including MCP copies, and Codex `request_user_input`)
is communicating, but its result arrives when the user answers, so the gap
before that result is waiting on the user too, like the time before a typed
prompt. A harness record between two messages does not split the gap; it closes
on the next message the model or user produced.

Each gap is measured from the latest timestamp seen so far, not the previous
message's. Parallel work can log a message earlier than the one before it:
Codex records an MCP call when it ends and dates the call back by its duration.
A step back in time adds nothing, so overlapping calls are not counted twice
and active time never exceeds the session's span. Session `active_seconds` and
bucket active time follow the same rule.

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
an explicit model window, and OpenCode sessions take theirs from the models.dev
catalog OpenCode caches (in its database for 2.x, in a `models.json` cache
file for 1.x; the window is unknown when no cache exists). Claude and Gemini infer the window from the model
when the source does not record one, and the API marks inferred values. An
inferred window grows to the next published tier when a call already exceeded
the smaller one, so an inferred peak never reads above 100%.

Compactions come from provider boundary records. Pre- and post-compaction token
counts are preserved when the source supplies enough information; missing
values remain unavailable rather than being invented.

## Distilled command success

`decant distill` reports `success_rate` per normalized command across the
sessions in scope. It counts only calls with a recorded result. Codex does not
record per-call results, so those calls stay out of the rate, and a command no
call recorded a result for has a `null` rate. Script comments floor the
percentage, so a command that ever failed never reads `100% ok`, and they omit
the percentage when the rate is `null`. Commands whose recorded calls all failed
are left out of scripts.

## Data quality signals

`unparsed_line` means Decant could not normalize a source line and is treated
as a substantive ingest issue. Other diagnostics, such as an unknown record
type or imperfect tool linkage, are informational format-drift sensors. Both
are preserved, but informational notices should not be described as data loss
without inspecting the session's issue details.

For the machine-readable field definitions, see the
[OpenAPI contract](api/openapi.yaml). For practical queries, see
[Local API recipes](api/recipes.md).
