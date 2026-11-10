# Distribution

Decant publishes native binaries for macOS and Linux on arm64 and x64. There is
no native Windows package.

## npm

Run Decant without installing it:

```sh
npx @dosu/decant@latest
```

Or install a persistent command:

```sh
npm install --global @dosu/decant@latest
decant
```

`@dosu/decant` is a Node.js launcher that selects the matching compiled binary.
The launcher needs Node.js 18 or newer; Bun is not required. Reinstall without
`--omit=optional` if npm omitted the platform package.

## Shell installer

The installer downloads the matching GitHub Release tarball, verifies its
checksum, and installs without `sudo`:

```sh
curl -fsSL https://raw.githubusercontent.com/dosu-ai/decant/main/install.sh | sh
```

Optional environment variables:

- `DECANT_VERSION`: release to install; defaults to the latest release.
- `DECANT_INSTALL_DIR`: destination; defaults to `~/.local/bin`.
- `DECANT_NO_MODIFY_PATH=1`: do not edit a shell startup file.
- `DECANT_BASE_URL`: release mirror with the same asset layout as GitHub. The
  installer trusts the mirror's `SHA256SUMS`, so the mirror must be an
  `https://` or `file://` URL, or `http://` to `localhost`, `127.0.0.1`, or
  `[::1]` (for example, an SSH port forward to a mirror on another machine).
  The curl installer path refuses any redirect that is not HTTPS. The wget
  path follows redirects while it downloads, then checks the logged response
  headers. A redirect to anything other than HTTPS or a relative path, which
  keeps the same scheme and host, makes the installer discard the file and
  exit before it verifies or installs anything.
- `DECANT_SKIP_ATTESTATION=1`: skip the provenance check described below,
  for a machine where `gh` is logged in but cannot reach GitHub's attestation
  API or Sigstore, such as one behind a restrictive proxy. The checksum still
  runs.

When the GitHub CLI is installed and has a github.com credential
(`gh auth token --hostname github.com` succeeds, which needs no network), the
installer also runs `gh attestation verify` on the tarball against
`dosu-ai/decant` and refuses to install if that fails, including when the
credential has expired or `gh` is older than 2.49 and has no `attestation`
command. A mirror serves the same bytes, so its tarballs verify
the same way. Without `gh`, or with `gh` logged out, the installer prints that
it skipped the check and relies on the checksum alone.

## Homebrew

```sh
brew install dosu-ai/dosu/decant
```

Homebrew users who tap first can install the short formula name:

```sh
brew tap dosu-ai/dosu
brew trust dosu-ai/dosu   # Homebrew 6 or newer
brew install decant
```

## Docker

```sh
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -v decant-data:/var/lib/decant \
  -v "$HOME/.claude/projects:/sources/claude:ro" \
  -v "$HOME/.codex:/sources/codex:ro" \
  -v "$HOME/.gemini/tmp:/sources/gemini:ro" \
  -v "$HOME/.cursor/chats:/sources/cursor:ro" \
  -v "$HOME/.copilot/session-state:/sources/copilot:ro" \
  -v "$HOME/Library/Application Support/Code/User:/sources/vscode:ro" \
  -v "$HOME/.decant/atif:/sources/atif:ro" \
  ghcr.io/dosu-ai/decant:latest
```

The VS Code mount shows the macOS path. On Linux, mount `$HOME/.config/Code/User`
instead. The image reads one VS Code `User` directory, so mount VS Code
Insiders' directory there if that is the build you use. `/sources/atif` holds
ATIF trajectories. Mount a Harbor `jobs` directory there to read its runs.

The runtime uses [`gcr.io/distroless/cc-debian12`](https://github.com/GoogleContainerTools/distroless)
and has no shell or package manager. It includes glibc, the C++ runtime, and CA
certificates for optional HTTPS update checks. The image runs as `decant` with
UID/GID `999:999`, unchanged from the Debian runtime, so existing named volumes
stay writable. `HOME` and the archive directory are `/var/lib/decant`.
All source directories, including `/sources/atif`, exist and belong to `decant`.

Run the binary directly to inspect the image:

```sh
docker run --rm --entrypoint /usr/local/bin/decant ghcr.io/dosu-ai/decant:latest --version
docker logs <container>
```

`docker exec <container> sh` cannot work without a shell. For shell debugging,
build a temporary image with the runtime base changed to the distroless
`cc-debian12:debug` variant and its matching digest, then use
`docker run --rm -it --entrypoint /busybox/sh <debug-image>`. Decant does not
publish a debug tag.

Keep the host port bound to `127.0.0.1`; Decant's local API
has no credentials.

The image trusts a verified container bridge gateway so host traffic forwarded
through that loopback port can reach it. Custom Docker networks, Podman,
Kubernetes, and host networking can return `403 forbidden remote`. In those
environments, set `DECANT_TRUSTED_PEERS` to the exact forwarding IP or a narrow
IPv4 CIDR. Every trusted address can read and mutate the archive. Decant
refuses to start when an entry is neither an IP address nor an IPv4 CIDR.

## Source

Source builds need Bun 1.3 or newer:

```sh
git clone https://github.com/dosu-ai/decant.git
cd decant
bun run dev
```

Build a native binary for the current platform with:

```sh
bun run scripts/build-binaries.ts --target native
```

## Update

```sh
decant update           # install the newest release in place
decant update --check   # only report whether one exists, add --json for scripts
```

`decant update` asks the npm registry for the newest `@dosu/decant` version
and updates with the tool that owns the running binary:

| Install | What `decant update` does |
| --- | --- |
| `npm install --global` | Checks that npm serves this platform's package for the new version, then runs `npm install --global @dosu/decant@<version>` |
| Homebrew | Runs `brew update`, then `brew upgrade dosu-ai/dosu/decant`. A failed `brew update`, such as one caused by an unrelated tap, is reported and the upgrade still runs |
| Shell installer, meaning a binary in `DECANT_INSTALL_DIR` or `~/.local/bin` | Downloads the release tarball and `SHA256SUMS`, verifies the checksum, checks that the new binary reports the expected version, then renames it over the old one |
| Any other standalone binary | Explains how to update it instead of replacing it, because another tool such as mise or a distro package may own that file |
| `npx` | Prints `npx @dosu/decant@latest` |
| A project's `node_modules` | Prints the `npm install` command for that project |
| Docker | Prints `docker pull ghcr.io/dosu-ai/decant:latest` |
| Source checkout | Prints `git pull && bun install` |

A running background service (`decant service install`) notices the replaced
binary within about a minute and restarts on the new version, whichever row above
replaced it. The formula has no `brew services` block. Use
`decant service install`, which registers the stable `opt` path, rather than
adding one, or two copies would compete for the same port.

The shell installer download honors `DECANT_BASE_URL` and applies the same
mirror restrictions as the installer, but refuses any redirect that is not
HTTPS. The binary's directory must be writable. If you ran the installer
with `DECANT_INSTALL_DIR`, set it to the same directory when you run
`decant update`. `decant update` exits with status 1 when the registry check
fails, when a package manager fails (such as a global npm
prefix that needs `sudo`), or when the package manager succeeds but the
`decant` on `PATH` still reports the old version. The release workflow publishes
to npm a few minutes before GitHub Releases and the Homebrew tap, and npm can
name a version before its platform packages download. An update started in
that window fails before it changes anything, with a message to try again
shortly.

`decant doctor` prints the install channel `decant update` detected, along with
the Decant version, platform, archive schema version, and per-source discovery
counts. Paths outside the home directory are redacted and environment variables
are listed by name only, so the report can be pasted into a public issue.

The Docker image sets `DECANT_INSTALL_CHANNEL=docker`, and that variable is how
`decant update` recognizes it. Other containers, such as a devcontainer with
decant from npm or the installer, update the same way they would on the host.

Update checks are off by default. Turn them on with **Check for updates** in
Settings or `DECANT_UPDATE_CHECK=1`, and force them off with
`DECANT_UPDATE_CHECK=0`. With checks on, Decant asks the npm registry once a day
and shows a notice in the sidebar, under the `decant serve` banner, and after
CLI commands. The CLI notice goes to stderr. It stays off with `--json` or
`--quiet`, when `CI` is set, when stderr is not a terminal, and for the
`update`, `completion`, and `watch` commands. Source checkouts skip the daily
check. [Permissions](data-lifecycle.md#permissions) describes the cache file.

## Cut a release

Releases are cut by pushing a signed `vMAJOR.MINOR.PATCH` tag from `main`
(`just release 1.2.3`). A suffix such as `-beta.1` makes it a prerelease. A
backport is cut the same way from a `release/*` branch, such as `release/1.1`
branched from `v1.1.3` with the fix cherry-picked onto it. Push the branch
before running `just release` on it. A tag runs the `release.yml` stored at the
tagged commit, so also cherry-pick any release workflow changes made on `main`
since the branch point. Without them, the publishing jobs may lack the
`release` environment that npm and the Homebrew token require.

The tag triggers `.github/workflows/release.yml`. Before it builds anything, it
checks that the tag points at the run's commit and that the commit is on
`main` or a `release/*` branch on GitHub, so a tag on an unmerged commit fails
there. It then builds, signs, attests, and smoke-tests the binaries without
asking anyone.

The jobs that publish (`npm`, `docker`, `github-release`, and `tap-update`)
run in the `release` deployment environment, so each one waits for a
maintainer to approve it under **Review deployments** on the run page. `npm`
and `docker` wait at the same time and can be approved together.
`github-release` waits again after the post-publish npm smoke passes, and
`tap-update` waits after the Homebrew smoke passes, so a stable latest release
asks three times and a prerelease or backport asks twice. npm trusted
publishing and the `HOMEBREW_TOKEN` secret are scoped to that environment.
Those jobs then publish:

- a GitHub Release with the tarballs, `SHA256SUMS`, the Sigstore bundle, the
  CycloneDX SBOM, and `install.sh`
- the npm launcher and platform packages, with provenance
- `ghcr.io/dosu-ai/decant:<version>`
- an updated formula in the `dosu-ai/homebrew-dosu` tap, for a stable latest
  release only

Only a stable tag that is the highest stable version on the remote moves the
default channels that `npx`, `install.sh`, `brew install`, and `docker pull`
read:

| Tag | npm dist-tag | GitHub Release | GHCR `:latest` | Homebrew tap |
| --- | --- | --- | --- | --- |
| Highest stable, such as `v1.2.3` | `latest` | latest | moved | updated |
| Older stable backport, such as `v1.1.4` after `v1.2.3` | `previous` | not latest | unchanged | unchanged |
| Prerelease, such as `v1.3.0-beta.1` | `next` | prerelease, not latest | unchanged | unchanged |

The workflow only orchestrates. Release logic lives in `scripts/release/*.ts`,
where each script reads its inputs from environment variables and has unit
tests in `test/release-*.test.ts`. Outside Actions, a script prints the outputs
it would record, so steps can be rerun locally, for example
`VERSION=1.2.3 bun run scripts/release/render-homebrew-formula.ts` after
placing a `SHA256SUMS` in `dist/release/`.

To run the workflow by hand, for example after fixing a runner problem, run it
on the tag, not on a branch: `gh workflow run release.yml --ref v1.2.3 -f
version=1.2.3`. The metadata job refuses any other ref, because the `release`
environment only admits `v*` tags and a branch run would stall at the first
publishing job.

Re-running a failed release is safe: already-published npm versions are
skipped and an existing GitHub Release only has its assets refreshed. A rerun
of a publishing job asks for approval again.

## Verify a release

GitHub Releases include four platform tarballs, `SHA256SUMS`, the SLSA build
provenance for all of them, and an SBOM. The provenance ships twice:
`decant-<version>.sigstore.json` is the Sigstore bundle, and
`decant-<version>.intoto.jsonl` holds the same bundle as JSON Lines, the name
OpenSSF Scorecard looks for. Releases published before the `.intoto.jsonl`
copy was added ship only the `.sigstore.json` file. Pick a release tag, here
the latest, then download that release and verify the matching tarball:

```sh
TAG=$(gh release view -R dosu-ai/decant --json tagName -q .tagName)
gh release download "$TAG" -R dosu-ai/decant
sha256sum -c SHA256SUMS --ignore-missing      # Linux
shasum -a 256 -c SHA256SUMS --ignore-missing  # macOS
gh attestation verify decant-darwin-arm64.tar.gz -R dosu-ai/decant
```

To verify against the provenance published with the release instead of
GitHub's attestation API, pass the bundle. `gh` still downloads Sigstore's
trusted root unless it is already cached. The `.intoto.jsonl` file works in
place of the `.sigstore.json` file on releases that include it.

```sh
gh attestation verify decant-darwin-arm64.tar.gz -R dosu-ai/decant \
  --bundle "decant-${TAG#v}.sigstore.json"
```

Each release also ships `decant-<version>.cdx.json`, a CycloneDX SBOM of the
production packages pinned in `bun.lock`, which the binaries bundle. It leaves
out development-only packages and the Bun runtime compiled into each binary.
`SHA256SUMS` does not list the SBOM. The release workflow attests it against
every tarball and raw binary instead, so verify it with the SBOM predicate
type. Releases published before the SBOM was added have no such attestation.

```sh
gh attestation verify decant-darwin-arm64.tar.gz -R dosu-ai/decant \
  --predicate-type https://cyclonedx.org/bom
```

To check npm provenance, install into a scratch project and run
`npm audit signatures`. GHCR images carry build provenance and an SBOM
attestation of the image, which lists the Debian packages in the base image:

```sh
gh attestation verify "oci://ghcr.io/dosu-ai/decant:${TAG#v}" -R dosu-ai/decant
gh attestation verify "oci://ghcr.io/dosu-ai/decant:${TAG#v}" -R dosu-ai/decant \
  --predicate-type https://cyclonedx.org/bom
```

If macOS Gatekeeper blocks a tarball downloaded manually through a browser,
clear the quarantine attribute from that binary:

```sh
xattr -d com.apple.quarantine ./decant
```

npm, Homebrew, and the shell installer do not set the browser quarantine
attribute.
