# Contributing to decant

Thanks for improving decant. [AGENTS.md](AGENTS.md) is the canonical reference
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
bun install --frozen-lockfile
bun run dev
```

Dependency installation is explicit. `bun run dev` starts the local UI and runs
the startup sync. Open `http://127.0.0.1:3000`.

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
3. decant is local-first and offline: no outbound runtime network calls and no
   LLM calls.
4. Never commit secrets, private transcripts, or a personal archive DB.
5. The v8 schema is the baseline. Pre-v8 archives are rebuild-only.

Adding model pricing? Update `src/cost.ts`, include string normalization, and add
tests.

Adding a source tool? Add `src/sources/<tool>.ts`, synthetic fixtures, parser
tests, ingest/query coverage, and golden updates.

## Commits and pull requests

- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`,
  `refactor:`, `style:`, `ci:` with optional scope.
- Signing commits (`git commit -S`) is appreciated if your environment supports it.
- Branch off `main`, open a PR, and make sure CI is green.

## Reporting bugs and proposing features

Open an issue with enough detail to reproduce: decant version, OS, command,
actual result, and expected result. For security issues, do not open a public
issue; see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project.
