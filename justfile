# decant developer tasks. `just` lists recipes; `just check` is the local
# TypeScript plus native distribution definition of done.

default:
    @just --list --unsorted

# Quality gates
[group('gates')]
check: ts-check dist-check

[group('gates')]
ts-check:
    bun test
    bunx tsc --noEmit
    bunx biome check .

[group('gates')]
dist-check:
    bun run scripts/dist-check.ts

# TypeScript
[group('ts')]
test *ARGS:
    bun test {{ARGS}}

[group('ts')]
typecheck:
    bunx tsc --noEmit

[group('ts')]
lint:
    bunx biome check .

[group('ts')]
fmt:
    bunx biome check --write .

# Compile Bun standalone binaries (`ARGS`: --target native|all|darwin-arm64|...)
[group('dist')]
build-binary *ARGS:
    bun run scripts/build-binaries.ts {{ARGS}}

# Stage publishable npm launcher + platform packages under dist/npm
[group('dist')]
build-npm *ARGS:
    bun run scripts/build-npm.ts {{ARGS}}

# Build a local Docker image
[group('dist')]
docker-build *ARGS:
    docker build --platform linux/amd64 -t decant:local {{ARGS}} .

# Validate both Linux Docker release platforms without loading an image locally
[group('dist')]
docker-buildx *ARGS:
    docker buildx build --platform linux/amd64,linux/arm64 --output=type=cacheonly {{ARGS}} .

# Cut and push a signed release tag. VERSION is semver, no leading "v".
[group('dist')]
release VERSION:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -z "$(git status --porcelain)" ] || { echo "working tree is dirty"; exit 1; }
    branch="$(git rev-parse --abbrev-ref HEAD)"
    [ "$branch" = "main" ] || { echo "release from main, not $branch"; exit 1; }
    git fetch origin main
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main is not up to date with origin/main"; exit 1; }
    git tag -s "v{{VERSION}}" -m "v{{VERSION}}"
    git push origin "v{{VERSION}}"

# CLI
[group('cli')]
sync *ARGS:
    bun run src/cli.ts sync {{ARGS}}

[group('cli')]
watch *ARGS:
    bun run src/cli.ts watch {{ARGS}}

[group('cli')]
serve *ARGS:
    bun run src/cli.ts serve {{ARGS}}

[group('cli')]
ls *ARGS:
    bun run src/cli.ts ls {{ARGS}}

[group('cli')]
search QUERY *ARGS:
    bun run src/cli.ts search "{{QUERY}}" {{ARGS}}

[group('cli')]
stats *ARGS:
    bun run src/cli.ts stats {{ARGS}}

[group('cli')]
db-info *ARGS:
    bun run src/cli.ts db info {{ARGS}}

# Data / maintenance
[group('data')]
[confirm("Delete ~/.decant/decant.db and re-ingest from ~/.claude + ~/.codex?")]
db-rebuild:
    rm -f ~/.decant/decant.db ~/.decant/decant.db-wal ~/.decant/decant.db-shm
    bun run src/cli.ts sync

[group('data')]
hooks:
    pre-commit install
