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

- `DECANT_VERSION`: release to install; defaults to the latest stable release.
- `DECANT_INSTALL_DIR`: destination; defaults to `~/.local/bin`.
- `DECANT_NO_MODIFY_PATH=1`: do not edit a shell startup file.
- `DECANT_BASE_URL`: release mirror with the same asset layout as GitHub.

When the GitHub CLI is available, the installer also performs a best-effort
provenance check.

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
  ghcr.io/dosu-ai/decant:latest
```

The image runs as a non-root user and stores the archive in
`/var/lib/decant`. Keep the host port bound to `127.0.0.1`; Decant's local API
has no credentials.

The image trusts a verified container bridge gateway so host traffic forwarded
through that loopback port can reach it. Custom Docker networks, Podman,
Kubernetes, and host networking can return `403 forbidden remote`. In those
environments, set `DECANT_TRUSTED_PEERS` to the exact forwarding IP or a narrow
IPv4 CIDR. Every trusted address can read and mutate the archive.

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

## Verify a release

GitHub Releases include four platform tarballs, `SHA256SUMS`, and a Sigstore
bundle. Download the latest release and verify the matching tarball:

```sh
gh release download -R dosu-ai/decant
sha256sum -c SHA256SUMS --ignore-missing      # Linux
shasum -a 256 -c SHA256SUMS --ignore-missing  # macOS
gh attestation verify decant-darwin-arm64.tar.gz -R dosu-ai/decant
```

To check npm provenance, install into a scratch project and run
`npm audit signatures`. GHCR images also carry GitHub attestations.

If macOS Gatekeeper blocks a tarball downloaded manually through a browser,
clear the quarantine attribute from that binary:

```sh
xattr -d com.apple.quarantine ./decant
```

npm, Homebrew, and the shell installer do not set the browser quarantine
attribute.
