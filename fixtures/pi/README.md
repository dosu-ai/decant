# Pi fixtures

Each `.jsonl` file is one invented Pi coding agent session, in the format Pi
writes to `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<session id>.jsonl`
(session format version 3). Every path is under `/decant-fixture/pi-example`,
which no user can create.

- `sample.jsonl` uses two models with reasoning, file reads and edits, a
  failing shell call, a user-run shell command, an image, a compaction, a
  cache-warming usage entry, an aborted reply, and a second branch with a
  branch summary.
- `forked.jsonl` is a `/fork` of `sample.jsonl` taken after its first tool
  result. It starts with copies of the original's first six entries, which
  keep their ids, timestamps, and usage, and then continues on its own.
