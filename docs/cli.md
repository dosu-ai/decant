# CLI output, errors, and exit codes

This page is the contract for scripts and coding agents that call `decant`.
`decant --help` prints a short version of it.

## Where output goes

stdout carries the result. With `--json` or `--format json` it is one JSON
document. Otherwise it is rows of text or Markdown. stderr carries errors,
notes, and progress.

A command that fails writes nothing to stdout, with two exceptions.
`session rm --json` and `recommendations mark --json` report a failed operation
as their JSON result on stdout, with an `error` string, and exit 1.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. An empty result, such as `[]` from `ls --json`, is a success. |
| 1 | The command failed. The session does not exist, the archive is missing or unreadable, or something went wrong at runtime. |
| 2 | Usage error. The command, a flag, or a value is wrong, an argument is missing, or the operation needs a flag such as `--yes` or `--force` before it runs. Fix the command line and run it again. |
| 3 | `decant sync` finished but dropped source lines it could not parse. The sync report says how many under `issues_by_code.unparsed_line`. Everything else was indexed. |
| 75 | `decant serve`, running as the background service, saw its own binary change and exited so the OS restarts it on the new version. |

## Errors

Without `--json`, an error is a line on stderr that starts with `error: `.

```console
$ decant ls --tool claude
error: option '--tool <tool>' argument 'claude' is invalid. expected: claude_code | codex | gemini | opencode | cursor | copilot | vscode_copilot | atif
```

With `--json`, the error is one JSON object on a single line, and it is the last
line of stderr. stdout stays empty.

```console
$ decant ls --json --tool claude
{"error":{"code":"invalid_argument","message":"option '--tool <tool>' argument 'claude' is invalid. expected: claude_code | codex | gemini | opencode | cursor | copilot | vscode_copilot | atif","option":"--tool","value":"claude","expected":["claude_code","codex","gemini","opencode","cursor","copilot","vscode_copilot","atif"]}}
```

`code` and `message` are always present. `code` is stable, so branch on it.
`message` is for people and can change. The other fields appear when they apply.

| Field | When it is present |
|---|---|
| `option` | The flag whose value was rejected, such as `--limit`. |
| `argument` | The positional argument whose value was rejected, such as `id`. |
| `value` | The rejected value, as typed. |
| `expected` | The accepted values, when there is a fixed list. |
| `command` | The command that cannot take the value, such as `ls` for `--format md`. |
| `path` | The archive path the command tried to open. |

Other lines can come before the error on stderr, such as the sync notice below
or the help text a command group prints when it is run without a subcommand.
Parse the last line.

`--json` is found anywhere on the command line, so an error in a flag that comes
before it is still reported as JSON.

### Error codes

| Code | Exit | Meaning |
|---|---|---|
| `unknown_command` | 2 | No such command. The message suggests a near match when there is one. |
| `unknown_option` | 2 | No such flag on this command. |
| `missing_argument` | 2 | A required argument, or the value of a flag, is missing. |
| `invalid_argument` | 2 | A flag or argument has a value outside what it accepts. |
| `usage_error` | 2 | Any other problem with the command line, such as flags that cannot be combined or a command group run without a subcommand. |
| `archive_not_found` | 1 | `--db` or `DECANT_DB` names a path with no archive. See below. |
| `archive_unreadable` | 1 | Decant could not open the archive at that path. The message gives the reason, such as a directory, a file that is not a database, or a lock. |
| `session_not_found` | 1 | No session has that id. `decant ls` lists the ids. |
| `schema_too_new` | 1 | A newer Decant wrote the archive. Update Decant. |
| `schema_too_old` | 1 | The archive predates the oldest schema this version can migrate. See [Data lifecycle](data-lifecycle.md). |
| `schema_drift` | 1 | The archive's schema does not match what this version expects. |
| `command_failed` | 1 | Any other failure. The message says what happened. |

## Flag values

Decant rejects a value it would otherwise have to guess at.

- `--tool` takes one of `claude_code`, `codex`, `gemini`, `opencode`, `cursor`,
  `copilot`, `vscode_copilot`, or `atif`. These are the names `ls` prints.
- `--limit` takes an integer of 1 or more.
- `--format` takes `table`, `json`, or `md`. Only commands that print Markdown
  accept `md`: `show`, `session show`, `export`, and `distill skill`.
- `serve --port` takes 0 through 65535. Port 0 lets the OS pick one.
- Flags with a fixed list, such as `stats --by` and `export --as`, list the
  accepted values in their help and in the error.

## The archive path

`--db` or `DECANT_DB` sets the archive path. Without either, Decant uses
`~/.decant/decant.db` and creates it on first run.

When you name a path, only commands that fill an archive create it: `sync`,
`serve`, `watch`, and `db migrate`. Every other command fails with
`archive_not_found` and exit 1 when no file is there, and creates nothing.
Creating one there would answer a mistyped path with a new empty archive and a
result that reads as "no sessions".

To start an archive at a new path, sync into it first.

```sh
decant --db ./team.db sync
decant --db ./team.db ls --json
```

The Docker image sets `DECANT_DB`, so the same rule applies there. Its default
command is `serve`, which creates the archive. A one-off read in a fresh
container needs a volume that `serve` or `sync` has already filled.

When a result is empty and you did not expect it, `decant db info --json` shows
the path Decant read and how many sessions it holds.

## Sync before a read

Commands that read the archive sync the source directories first, so a new
session shows up without a separate `decant sync`. On a new archive, or after a
long gap, that sync can take a while. When it runs for more than about a second,
Decant prints one line to stderr:

```text
note: syncing session logs before this command, 658 of 1800 files checked so far. Pass --no-sync to skip the sync.
```

`--quiet` suppresses the line. `--no-sync` or `DECANT_NO_SYNC` skips the sync,
and the command reads the archive as it is. The line never goes to stdout, so
`--json` output stays parseable.

## Local API

`decant serve` serves the same archive over HTTP on loopback. The OpenAPI 3.1
contract is [api/openapi.yaml](api/openapi.yaml), and a running server exposes
it at <http://127.0.0.1:3000/api/openapi.json>. The API reports errors as
`{"error": "<message>", "code": "<code>"}`, and it shares `session_not_found`
and the `schema_*` codes with the CLI. See [API routes](api/routes.md).
