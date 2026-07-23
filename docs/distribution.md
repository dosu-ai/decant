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
