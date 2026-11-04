# Copilot CLI fixtures

Each directory is one GitHub Copilot CLI session as it appears under
`~/.copilot/session-state/<session id>/`, holding only the `events.jsonl`
journal Decant reads. All of it is invented.

- `sample` is a two-model session with reasoning, file edits, a failing shell
  call, an MCP call, a compaction, an abort, and a shutdown usage summary.
- `resumed` is a session resumed on a build that restarted its usage counters,
  with a `task` subagent whose events share the parent's journal.
