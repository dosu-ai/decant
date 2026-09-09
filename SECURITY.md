# Security Policy

## Supported versions

Security fixes apply to the latest release and current `main`. Verify issues
against one of those builds before reporting.

## Reporting a vulnerability

Do not open a public issue for security vulnerabilities.

Report privately through
[GitHub's private vulnerability reporting flow](https://github.com/dosu-ai/decant/security/advisories/new),
reachable from the repository's **Security** tab. Include:

- a description of the issue and impact,
- steps to reproduce or a proof of concept,
- affected version/commit and environment,
- any suggested remediation.

We aim to acknowledge reports within a few days and will keep you updated while
we investigate and prepare a fix.

## Scope and threat model

Decant is a local-first, offline tool. It reads CLI session logs that already
exist on disk (`~/.claude`, `~/.codex`), writes a local SQLite archive, and makes
no outbound runtime network requests. `decant serve` is intended for local use
and binds to `127.0.0.1` by default.

In scope:

- Parser handling of malformed or adversarial session files.
- The local web UI exposing the archive beyond the local machine.
- Unsafe filesystem access through settings or launcher paths.
- Accidental inclusion of secrets, transcripts, or archive data in the repo.

Out of scope:

- Running the local UI on an untrusted or public network without your own
  hardening.
- Vulnerabilities in upstream dependencies, though a heads-up is welcome.
- Content readable in the archive by someone who already has read access to your
  user account. The archive is protected by filesystem permissions, not
  encryption.

## Handling your data

Your session transcripts and archive can contain sensitive content and should
stay on your machine. Never commit a real archive or session data. The committed
fixtures are synthetic, and `test/golden/` must stay derived from those fixtures
only.

The archive is a second, durable copy of your transcripts, and it is not
encrypted. `~/.decant/decant.db` holds prompts, tool arguments, tool output, the
canonicalized raw records for retained transcript messages, and absolute local
paths. In practice that means source code, file contents, and any credentials
that passed through a session.
Decant creates it at mode `0600`, and creates `~/.decant` at `0700` when it
creates that directory; an existing directory keeps its own mode. Deleting a
session removes its rows, but deleted text may remain recoverable in freed pages
until `decant db vacuum` rewrites the archive. See
[What the archive stores](docs/data-lifecycle.md#what-the-archive-stores) for
how to inspect and remove it.
