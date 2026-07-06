# Distribution

Decant's TypeScript migration ships as one Bun-authored app through three
paths: npm, Docker, and source.

## npm

The npm package is a Node-compatible launcher. `npx` starts under Node, but
Decant uses `bun:sqlite`, so the launcher selects a platform package containing
a Bun-compiled standalone binary.

The package is a release target, not a currently published install path until
the first Release workflow run succeeds.

```sh
npx @dosu/decant --help
npx @dosu/decant sync
npx @dosu/decant serve
```

Package layout:

- `@dosu/decant`: thin CommonJS launcher at `npm/decant/bin/decant.cjs`.
- `@dosu/decant-darwin-arm64`
- `@dosu/decant-darwin-x64`
- `@dosu/decant-linux-arm64`
- `@dosu/decant-linux-x64`

Build native artifacts for a local smoke test:

```sh
bun run scripts/build-binaries.ts --target native --out-dir /tmp/decant-bin
TARGET=darwin-arm64
DECANT_BINARY_PATH="/tmp/decant-bin/$TARGET/decant" node npm/decant/bin/decant.cjs --help
bun run scripts/build-npm.ts --target native --binary-dir /tmp/decant-bin --out-dir /tmp/decant-npm --no-build --clean
```

Set `TARGET` to the emitted target key for your platform; `darwin-arm64` is the
native target on Apple Silicon Macs.

Build all release artifacts:

```sh
bun run scripts/build-npm.ts --target all --clean --version 0.1.0
```

Release builds stamp the same version into package metadata and the compiled
binary. The release workflow publishes all platform packages first, then the
launcher, so `optionalDependencies` always point at packages that already exist.

The launcher prints a clear reinstall message if optional dependencies were
disabled and the matching platform package is missing. Windows packages are
deferred.

## Docker

The image compiles Decant in an `oven/bun` builder and runs the standalone
binary in a non-root Debian runtime. Docker Desktop file watching across bind
mounts is unreliable, so the default command disables native filesystem watches
and relies on the periodic sweep.

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/dosu-ai/decant:local .
```

Local run:

```sh
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -v decant-data:/var/lib/decant \
  -v "$HOME/.claude/projects:/sources/claude:ro" \
  -v "$HOME/.codex:/sources/codex:ro" \
  ghcr.io/dosu-ai/decant:local
```

Use a locally built tag such as `ghcr.io/dosu-ai/decant:local` until the first
Release workflow publishes `ghcr.io/dosu-ai/decant:latest`.

The container binds `0.0.0.0` inside the network namespace so Docker port
publishing can reach it. Publish to `127.0.0.1` on the host, as shown above.
Do not use `-p 3000:3000` unless you intentionally want to expose the archive
port on every host interface. The image sets
`DECANT_TRUSTED_PEERS=172.16.0.0/12` so requests forwarded from Docker bridge
peers can pass the local-only API guard; override it with a narrower peer or
CIDR if your Docker network uses a different gateway.

## Source

Source remains the contributor path and the fastest dev loop:

```sh
bun run dev
```

`bun run dev` runs `bun install --frozen-lockfile`, starts `decant serve`, opens
from the existing archive immediately, and keeps watching source logs. Source
installs require Bun.
npm and Docker installs do not.
