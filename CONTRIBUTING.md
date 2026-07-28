# Contributing to Decant

Thanks for improving Decant. [AGENTS.md](AGENTS.md) is the canonical reference
for commands, conventions, and project invariants; this file is the shorter
on-ramp.

## Prerequisites

- Bun 1.3+
- pre-commit, if you want local hooks (`pipx install pre-commit` or
  `brew install pre-commit`)
- Docker, only if you are touching the container build

## Get set up

```bash
git clone https://github.com/dosu-ai/decant
cd decant
bun run dev
```

`bun run dev` performs a frozen dependency install, starts the local UI, and
runs the startup sync. Open `http://127.0.0.1:3000`.

Install optional hooks after setup if you use pre-commit locally:

```bash
pre-commit install
```

## Make your change

We work test-first. Add or update focused tests alongside behavior changes and
keep commits small.

Before you push:

```bash
bun test
bunx tsc --noEmit
bunx biome check .
```

`pre-commit run --all-files` runs the local hook suite.

## Project invariants

1. Core modules do not print; `src/cli.ts` owns output and exit codes.
2. One Bun process owns SQLite directly. Do not reintroduce the old daemon,
   Phoenix app, token/lock file, or cross-process API contract.
3. Decant is local-first and offline: no outbound runtime network calls and no
   LLM calls.
4. Never commit secrets, private transcripts, or a personal archive DB.
5. Pre-v8 archives are rebuild-only; v8 and newer migrate forward on open. See
   `LATEST_SCHEMA_VERSION` in `src/db.ts` for the current baseline rather than
   trusting a number written down here.

Adding model pricing? Update `src/cost.ts`, include string normalization, and add
tests.

Adding a source tool? Add `src/sources/<tool>.ts`, synthetic fixtures, parser
tests, ingest/query coverage, and golden updates.

Adding support for a new agent CLI? Follow the agent-executable prompt in docs/prompts/add-source.md.

## How we work

Decant is trunk-based. There is one long-lived branch, `main`, and it is always
releasable.

- **Branch off `main`, keep it short-lived.** Days, not weeks. A branch that
  lives long enough to drift is a branch that will conflict, and conflicts get
  resolved by whoever has the least context.
- **One PR, one concern.** A PR that mixes a feature with unrelated cleanup is
  harder to review and much harder to revert.
- **Squash-merge.** `main`'s history is one commit per PR. Your branch is
  deleted on merge.
- **`main` stays green.** Every PR needs CI passing and one approving review.
- **Tags are the only thing that publishes.** Merging to `main` ships nothing.
  Pushing a `v*` tag builds, signs, and publishes to npm, Homebrew, GHCR, and
  the GitHub Release. Nothing else does. See
  [docs/releasing.md](docs/releasing.md).

## Commits and pull requests

- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`,
  `refactor:`, `style:`, `ci:` with optional scope.
- **Commits must be signed.** `main` rejects unsigned commits. Either GPG or SSH
  signing works — see
  [GitHub's guide](https://docs.github.com/authentication/managing-commit-signature-verification)
  — and `git config commit.gpgsign true` makes it automatic.
- Branch off `main`, open a PR, and make sure CI is green.

## Reporting bugs and proposing features

Open an issue with enough detail to reproduce: Decant version, OS, command,
actual result, and expected result. For security issues, do not open a public
issue; see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project.
