# Distribution

Decant ships as one Bun-authored app through five paths: npm, the shell
installer, Homebrew, Docker, and source.

## npm

The npm package is a Node-compatible launcher. `npx` starts under Node, but
Decant uses `bun:sqlite`, so the launcher selects a platform package containing
a Bun-compiled standalone binary.

The package is a release target, not a currently published install path until
the first Release workflow run succeeds.

```sh
npx @dosu/decant          # starts the web UI and opens your browser
npx @dosu/decant --help
npx @dosu/decant sync
npx @dosu/decant serve
```

Package layout:

- `@dosu/decant`: thin CommonJS launcher at `npm/decant/bin/decant.cjs`. It
  installs a `decant` binary, so after a global install the command is just
  `decant`. The launcher publishes scoped because npm refuses the unscoped
  `decant` as too similar to existing packages; see "npm package naming" below.
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
launcher, so `optionalDependencies` always point at packages that already
exist.

The launcher prints a clear reinstall message if optional dependencies were
disabled and the matching platform package is missing. Windows packages are
deferred.

### npm package naming

The launcher publishes as `@dosu/decant`, not as an unscoped `decant`. That is
not a style preference — npm refuses the unscoped name outright:

```
403 Forbidden - PUT https://registry.npmjs.org/decant
Package name too similar to existing packages dedent,recast
```

npm's typosquat similarity check rejects new unscoped names that are close to
existing ones. Two things make this easy to trip over a second time:

- **The check runs only at publish time.** `npm view decant` returns 404 and
  `npm publish --dry-run` succeeds, so every pre-flight signal says the name is
  available (npm/cli#9188).
- **There is no appeal.** npm's disputes policy does not resolve name claims on
  request, and the error's own suggested remedy is to publish under a scope.

Scoped names are exempt from the check, so `@dosu/decant` is safe permanently.
A global install still puts a `decant` binary on PATH, and Homebrew, the shell
installer, and the Docker image are all unaffected — only the one-off `npx`
invocation carries the scope.

`test/distribution.test.ts` asserts the staged launcher is scoped, so reverting
this fails locally rather than at tag time.

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
clearly when neither exists. `curl` and `tar` never set
`com.apple.quarantine`, so this path needs no Gatekeeper workaround on macOS
even though v0.1.0 binaries are not notarized (see "Verify a release").

## Homebrew

The `dosu-ai/dosu` tap carries a formula that installs the same prebuilt
release tarball as every other channel — there is no source build:

```sh
brew install dosu-ai/dosu/decant
```

Or with the tap and short names:

```sh
brew tap dosu-ai/dosu
brew trust dosu-ai/dosu   # Homebrew 6.0+ only — skip on older versions
brew install decant
```

The formula is rendered from `packaging/homebrew/decant.rb.template` during the
release run, smoke-tested on all four supported OS/architecture targets, and
pushed to `dosu-ai/homebrew-dosu` only for stable releases that are the newest
stable tag. A backport never moves the tap. Because Homebrew downloads and
extracts the tarball itself, this path is also free of the quarantine flag.

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

The API is unauthenticated, so the peer's source address is the only real
boundary; the `Host` header check in front of it is not an access control,
because any non-browser client can send `Host: localhost`. The image therefore
ships no peer allowlist. It sets `DECANT_TRUST_DEFAULT_GATEWAY=1`, which trusts
exactly one derived address: the container's own bridge gateway, which is the
address the port publisher forwards host traffic from. A second container on the
same bridge keeps its own source address (`172.17.0.5`, say) and gets
`403 forbidden remote`.

The gateway is derived once at startup, from `/proc/net/route` and
`/sys/class/net`, and only when all of the following hold. Anything else
resolves to no peers rather than guessing:

- exactly one usable IPv4 default route, so a multi-homed host contributes
  nothing;
- the gateway is on-link on that route's interface;
- the gateway is inside `172.16.0.0/12`, a bound on the derivation rather than
  an allowlist, so the image's default trust set stays a strict subset of the
  `DECANT_TRUSTED_PEERS=172.16.0.0/12` it used to ship;
- the interface is a veth whose peer sits in another network namespace, which
  is true of a bridge-networked container and false for `--network host`,
  macvlan, ipvlan and vlan links, where the "default gateway" is the LAN or VPC
  router.

So `--network host`, macvlan/ipvlan, multi-homed hosts, and bridges outside
`172.16.0.0/12` (Podman's default `10.88.0.0/16`, an explicit
`--subnet 10.10.0.0/16`, Kubernetes pods) trust nobody beyond loopback and
answer `403 forbidden remote` on `/api/*`. Shapes outside `172.16.0.0/12` were
already refused by the allowlist the image used to ship. A shape inside it, such
as a macvlan container on a `172.16.0.0/12` LAN, loses trust it used to have,
which is the point of the change. Give these deployments the exact forwarding
address with `-e DECANT_TRUSTED_PEERS=192.168.65.1`, which replaces the gateway
default entirely, or turn the derivation off with
`-e DECANT_TRUST_DEFAULT_GATEWAY=0`. Prefer single addresses: every entry, and
every address inside a CIDR, reads the entire archive with no credential.

## Source

Source remains the contributor path and the fastest dev loop:

```sh
bun run dev
```

`bun run dev` performs a frozen dependency install, starts `decant serve`,
performs the startup sync, and keeps the archive current. Source installs
require Bun; npm and Docker installs do not.

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

Each release also ships its attestation as `decant-<version>.sigstore.json`
(covering the tarballs, the raw binaries, and `SHA256SUMS` itself), so
verification works offline from release assets alone:

```sh
gh attestation verify decant-darwin-arm64.tar.gz -R dosu-ai/decant \
  --bundle decant-0.2.0.sigstore.json
```

**npm provenance.** Confirm the published packages carry Sigstore-signed
provenance. `npm audit signatures` checks the packages installed in the
current project, so install the release into a scratch project first:

```sh
mkdir -p /tmp/decant-verify && cd /tmp/decant-verify
npm init -y >/dev/null
npm install @dosu/decant@0.1.0
npm audit signatures
```

**LICENSE and NOTICE.** Every published package — the launcher and all four
platform packages — ships both files. `npm pack <pkg>@<version>` downloads the
registry tarball so you can inspect exactly what users receive:

```sh
npm pack decant@0.1.0    # repeat for @dosu/decant and @dosu/decant-<os>-<arch>
tar -tzf decant-0.1.0.tgz | grep -E 'LICENSE|NOTICE'
```

**macOS signing.** v0.1.0 darwin binaries are ad-hoc signed and **not
notarized** — the Apple Developer Program enrollment that Developer ID signing
requires is not in place yet. The practical consequence is narrow: a tarball
downloaded through a browser carries `com.apple.quarantine`, which the
extracted binary inherits, so Gatekeeper blocks the first run until you clear
it:

```sh
xattr -d com.apple.quarantine ./decant
```

`brew install`, `npx @dosu/decant`, and `install.sh` are all unaffected — Homebrew,
npm, and `curl`/`tar` never set the quarantine attribute. Integrity for this
release rests on SLSA build provenance, `SHA256SUMS`, and the attestation
check `install.sh` runs, not on an Apple signature. Configuring the five Apple
secrets flips the same pipeline to Developer ID signing plus notarization with
no workflow change; see
[docs/releasing.md](releasing.md#macos-signing-and-notarization).
