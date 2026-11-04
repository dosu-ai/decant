# Contributing to Decant

Thanks for improving Decant. Bug reports, feature proposals, documentation
fixes, and code contributions are welcome.

Before sharing logs or fixtures, remember that coding-agent transcripts can
contain source code, prompts, credentials, and local paths. Use synthetic data
only. See [Security and privacy](#security-and-privacy) below.

## Report a bug or propose a feature

Use the repository's issue templates. Paste the output of `decant doctor`,
which reports the version, install method, platform, schema versions, and
per-source session counts without any transcript content. Add the exact
command, the expected result, and the actual result. A small, hand-written
synthetic reproduction is especially helpful.

Report security vulnerabilities privately through [SECURITY.md](SECURITY.md),
not a public issue.

## Development setup

Requirements:

- Bun 1.3 or newer.
- Docker only when changing the container build.
- Optional: [pre-commit](https://pre-commit.com) for local hooks.
- Optional: [T3 Code](https://t3.codes) runs `t3.json`'s setup script, which
  installs dependencies, in each new worktree.

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

Formatting and the type check run on each commit. The test suite runs on
`git push`.

## Before you start

Review time is limited, so agree on the problem before writing a large change:

- Bug fixes, pricing updates, and documentation fixes can go straight to a
  pull request. Link the issue if one exists.
- New sources, new commands, new UI features, and changes to existing behavior
  need an issue or a [discussion](https://github.com/dosu-ai/decant/discussions)
  first, where a maintainer agrees on the direction and scope.
- Solve one problem per pull request. A second fix or an unrelated cleanup
  goes in its own pull request.

If a maintainer picks up a stalled pull request, they continue it on a
maintainer branch with your commits squashed into one and a `Co-authored-by`
trailer crediting you, then close the original with a link to the new one.

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
bun run scripts/pr-policy.ts
just check
```

`scripts/pr-policy.ts` compares your branch with `origin/main` and fails if a
committed migration changed, if a model rate or the route manifest
(`src/route-paths.ts`) changed without its docs, or if a fixture contains a
real home-directory path, email address, or key-shaped string. Add the
`docs-not-needed` label to a pull request when such a change truly needs no
doc update.

`just check` also runs `scripts/dist-check.ts`, which builds and installs staged
native/npm artifacts, so it needs network access. It validates that the
compiled binary ships React's production build and passes distribution smoke
tests. If
Docker is in scope and available, also run a local image build and `--help`
smoke.

Do not weaken or remove tests to make a change pass.

## Commits and pull requests

- Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`,
  `refactor:`, and `chore:`.
- Sign commits. The protected `main` branch requires verified commits.
- Keep one concern per pull request and explain the user-visible outcome.
- Fill in every section of the pull request template. Verification names the
  commands and checks you ran and what you saw.
- Link the issue the pull request closes when one exists.
- Keep `main` green, as every pull request needs passing CI and review.

CodeRabbit reviews every pull request once it leaves draft. Its approval is
enough to merge unless the change touches a path in `.github/CODEOWNERS`, which
needs a maintainer's review. Maintainers squash-merge pull requests.

## Security and privacy

- Never commit real Claude Code or Codex transcripts, Gemini CLI, OpenCode, or
  Cursor CLI sessions (including OpenCode's `opencode.db` and Cursor's
  `store.db`), a personal Decant archive,
  exported real sessions, tokens, keys, or `.env` files. Do not put content from
  these sources in fixtures or issues without sanitising it first.
- Write fixtures from scratch using invented prompts, paths, tool results, and
  identifiers. Editing a real transcript does not make it synthetic.
- Keep logs and issue output redacted. Prefer record shapes, counts, and field
  names over content.
- Decant stays offline at runtime. Features that require hosted services,
  outbound runtime calls, or LLM calls are out of scope.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
