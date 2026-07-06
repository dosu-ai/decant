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

## Shell installer

For machines without Node, `install.sh` fetches the prebuilt release tarball
for the current platform, verifies its SHA256 against the release's
`SHA256SUMS` (aborting on any mismatch), runs a best-effort
`gh attestation verify` when `gh` is available, and installs the binary
without sudo. Inspect it before running if you like
(`curl -fsSL <url> | less`):

```sh
curl -fsSL https://raw.githubusercontent.com/dosu-ai/decant/main/install.sh | sh
```

Knobs, all optional:

- A positional argument or `DECANT_VERSION` pins a version (with or without
  the leading `v`); the default is the latest stable release.
- `DECANT_INSTALL_DIR` overrides the install directory
  (default `~/.local/bin`).
- `DECANT_NO_MODIFY_PATH=1` prints the `PATH` export line instead of appending
  it to your shell rc file.
- `DECANT_BASE_URL` points downloads at a mirror that lays assets out like
  GitHub Releases (default `https://github.com/dosu-ai/decant/releases`).

The script uses `curl` when present and falls back to `wget`; it errors
clearly when neither exists.

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
port on every host interface.

`serve` allows API requests from peers in `DECANT_TRUSTED_PEERS`
(comma-separated IPs or IPv4 CIDRs) **unioned** with any `--trusted-peer
<cidr>` flags (repeatable, or comma-separated) passed on the command line —
the two sources add together and neither one silently drops the other. The
image sets `DECANT_TRUSTED_PEERS=172.16.0.0/12` so requests forwarded from the
default Docker bridge gateway pass the guard out of the box. Overriding the
container command with extra `--trusted-peer` flags only *adds* peers; it
cannot narrow the image's baked-in default. To narrow or clear the trusted set,
override the environment variable itself at `docker run` time instead, for
example `-e DECANT_TRUSTED_PEERS=10.0.0.0/24`, or `-e DECANT_TRUSTED_PEERS=` to
trust no forwarded peers and rely on the `127.0.0.1` host publish alone.

## Source

Source remains the contributor path and the fastest dev loop:

```sh
bun run dev
```

`bun run dev` runs `bun install --frozen-lockfile`, starts `decant serve`, performs
the startup sync, and keeps the archive current. Source installs require Bun.
npm and Docker installs do not.

## Verify a release

Every release artifact is independently verifiable; none of the checks below
require trusting the registry or a maintainer's word alone. See
[docs/releasing.md](releasing.md) for who runs a release; this section is for
anyone verifying one after the fact.

**Checksums.** Download `SHA256SUMS` from the same GitHub Release as the
tarball and verify before extracting:

```sh
sha256sum -c SHA256SUMS --ignore-missing      # Linux
shasum -a 256 -c SHA256SUMS --ignore-missing  # macOS
```

**Build provenance.** Tarballs, raw binaries, and the GHCR image each carry a
GitHub SLSA build-provenance attestation:

```sh
gh attestation verify decant-darwin-arm64.tar.gz -R dosu-ai/decant
gh attestation verify oci://ghcr.io/dosu-ai/decant:0.1.0 -R dosu-ai/decant
```

The `oci://` form needs a registry login first (`docker login ghcr.io`).

**npm provenance.** Confirm the published packages carry Sigstore-signed
provenance:

```sh
npm audit signatures
```

**LICENSE and NOTICE.** Every published package (the launcher and all four
platform packages) stages both files. Confirm they are declared and actually
packed:

```sh
npm pack --dry-run             # run inside npm/decant or any npm/decant-<platform> dir
tar -tzf dosu-decant-*.tgz | grep -E 'LICENSE|NOTICE'
```

**macOS signing.** darwin binaries are Developer ID-signed and notarized from
v0.1.0 onward, so there are no Gatekeeper workarounds to document anywhere in
this repo: a browser-downloaded tarball runs after extraction with no
`xattr -d` or "Open Anyway" step. `spctl -a -t exec -vv ./decant` reports
`accepted`, `source=Notarized Developer ID`.
