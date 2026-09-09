# Contributing to Decant

Thanks for improving Decant. Bug reports, feature proposals, documentation
fixes, and code contributions are welcome.

Before sharing logs or fixtures, remember that coding-agent transcripts can
contain source code, prompts, credentials, and local paths. Use synthetic data
only. See [Security and privacy](#security-and-privacy) below.

## Report a bug or propose a feature

Use the repository's issue templates and include the Decant version, operating
system and architecture, install method, exact command, expected result, and
actual result. A small, hand-written synthetic JSONL reproduction is especially
helpful.

Report security vulnerabilities privately through [SECURITY.md](SECURITY.md),
not a public issue.

## Development setup

Requirements:

- Bun 1.3 or newer.
- Docker only when changing the container build.
- Optional: [pre-commit](https://pre-commit.com) for local hooks.

```sh
git clone https://github.com/dosu-ai/decant.git
cd decant
bun run dev
```

`bun run dev` performs a frozen dependency install, starts the local UI at
<http://127.0.0.1:3000>, indexes existing sessions, and watches for changes.

Install the optional hooks with:

```sh
pre-commit install
```

## Make a change

Branch from `main`, keep the change focused, and add or update tests alongside
behavior changes. Coding agents should read [AGENTS.md](AGENTS.md) for the
architecture, invariants, and documentation map.

Useful contribution paths:

- New source parser, following [Add a source](docs/adding-a-source.md).
- Model pricing, which requires updating `src/cost.ts`, normalizing model
  names, adding focused tests, and citing dated first-party rates in
  [Pricing estimates](docs/pricing.md).
- Local API: update the implementation, `docs/api/openapi.yaml`,
  `docs/api/routes.md`, and contract tests together.
- Schema, which requires adding a new migration and never editing a migration
  already committed to a branch. Update the effective schema and migration
  tests together.
- UI: include a screenshot or short recording in the pull request.

When testing against a scratch archive, pass `--no-sync` or set
`DECANT_NO_SYNC` so it is not populated from your real session directories:

```sh
bun run src/cli.ts --db /tmp/decant-dev.db --no-sync serve --no-open
```

## Validate

Run the focused tests while iterating, then the full local gate before opening
a pull request:

```sh
bun test
bunx tsc --noEmit
bunx biome check .
just check
```

`just check` also builds and installs staged native/npm artifacts, so it needs
network access. If Docker is in scope and available, also run a local image
build and `--help` smoke.

Do not weaken or remove tests to make a change pass.

## Commits and pull requests

- Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`,
  `refactor:`, and `chore:`.
- Sign commits. The protected `main` branch requires verified commits.
- Keep one concern per pull request and explain the user-visible outcome.
- Include the commands you ran and their results.
- Link the issue the pull request closes when one exists.
- Keep `main` green, as every pull request needs passing CI and review.

Maintainers squash-merge pull requests.

## Security and privacy

- Never commit real Claude Code or Codex transcripts, a personal Decant
  archive, exported real sessions, tokens, keys, or `.env` files.
- Write fixtures from scratch using invented prompts, paths, tool results, and
  identifiers. Editing a real transcript does not make it synthetic.
- Keep logs and issue output redacted. Prefer record shapes, counts, and field
  names over content.
- Decant stays offline at runtime. Features that require hosted services,
  outbound runtime calls, or LLM calls are out of scope.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
