# Releasing decant

Audience: a maintainer cutting a decant release. This is a condensed runbook
for the tag-driven release pipeline decant's automation is designed around;
it has two parts — a one-time bootstrap that happens once, before the first
tag, and the steady-state process every release after that follows.

Distribution channels and per-artifact verification live in
[docs/distribution.md](distribution.md); this doc is about the process of
cutting a release, not the shape of what gets published.

The last five sections are the reference `.github/workflows/release.yml` links
to from its comments: the tag guard, tarball determinism, macOS signing, the
determinism canary, and the npm bootstrap.

## One-time bootstrap

The first release needs credentials configured before the first tag. **The
specifics — which credential, what scope, in what order, and when each is
revoked — are deliberately not in this repository.** Publishing that alongside
the workflow that consumes it would hand an attacker both the target list and
the timing.

Maintainers: the bootstrap runbook lives with the org's other operational
credentials documentation. Ask a repository admin.

What is safe to state here, because `release.yml` already shows it:

- The pipeline reads `NPM_TOKEN` and `HOMEBREW_TOKEN`, plus five Apple signing
  secrets. Each is optional in the sense that its absence changes behavior
  rather than breaking the run: no Apple secrets means ad-hoc signing instead
  of Developer ID, and no `NPM_TOKEN` routes npm publishing to OIDC.
- npm publishing moves to OIDC trusted publishing after the first release.
  Token-based publishing exists only because trusted publishers cannot be
  configured on packages that do not yet exist.
- The repository must be public before the first publish; npm provenance
  hard-fails from a private repository.

One manual step has no automated equivalent: a GHCR package created under an
organization is **private on first push**, even from a public repository. The
push succeeds and an anonymous `docker pull` then fails with 401. There is no
API to change package visibility — it is web UI only, and has been since 2023
(cli/cli#6820). Set it once at
`https://github.com/orgs/dosu-ai/packages/container/decant/settings` under
"Change visibility"; later releases inherit it. Note that public is one-way.

The `docker` job checks anonymous pullability after pushing and warns if it
fails, so a release never looks green while `docker pull` is broken for
everyone else.

Before the first tag, also confirm:

- A full-ref secret scan (gitleaks or similar) across every ref and tag.
- `main` is green and carries the release-blocking work — the tag is what
  publishes it, so nothing lands as a follow-up.

## Steady-state release

Every release after the bootstrap:

1. Confirm `main` is green. Run `just check` locally first if you want a
   second opinion before pushing a tag.
2. Cut and push a signed, annotated tag:

   ```sh
   git tag -s v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

3. Watch the release workflow's job graph:

   ```
   meta (guard) -> verify -> build (+sign +attest) -> smoke-darwin
     -> npm (OIDC) -> npm-smoke -> github-release
       -> homebrew-formula -> homebrew-smoke -> tap-update (stable latest only)
     -> docker (fans out in parallel, once smoke-darwin passes)
   ```

   `meta` derives and guards the version (rejects a `workflow_dispatch` whose
   ref isn't the tagged commit) and computes whether this is the newest
   stable release — the single source of truth every downstream job reads for
   `:latest`, the npm dist-tag, and the tap update. `smoke-darwin` covers both
   Apple architectures and is a gate, not an observer: nothing publishes until
   both signed darwin binaries pass it. `npm-smoke` exercises all four supported
   OS/architecture targets before the release page advances; `homebrew-smoke`
   covers three, since Homebrew supports Linux on x86_64 only. `determinism` hangs off `build` as the one non-blocking
   job in the graph.
4. Spot-check after the run finishes:
   - `npx @dosu/decant@$VERSION --version` (use `@latest` only when this release's
     `meta` reported it as the newest stable tag — a backport is never
     `latest` by design).
   - `curl -fsSL .../install.sh | sh` on one machine.
   - On a Mac, run the darwin tarball binary once — this catches signature
     regressions no Linux job can.
   - Confirm the release page has all four tarballs, `SHA256SUMS`, and the
     `decant-<version>.sigstore.json` attestation bundle, and run
     `gh attestation verify` on one asset (append
     `--bundle decant-<version>.sigstore.json` to verify offline from the
     bundle the release ships).
   - `brew upgrade decant` — the tap is a published channel, so a stale
     formula is a user-visible regression, not a cosmetic one.
5. **Failure recovery.** Fix the problem, don't delete anything, and re-run.
   Two ways to re-run:
   - Re-run the failed workflow run directly — it reuses the original tag's
     commit.
   - Dispatch fresh, with the tag as the ref:
     `gh workflow run release.yml --ref vX.Y.Z -f version=X.Y.Z` (`meta`
     rejects any dispatch whose ref isn't the commit the tag points at, so a
     dispatch from `main` after a newer tag exists can't accidentally
     republish an old version as if it were current).

   Every downstream job is safe to re-run because it's idempotent:
   - npm publishes skip any package/version that already exists on the
     registry.
   - `github-release` checks `gh release view` first — it creates the release
     only on a miss, and uploads assets with `--clobber` on a hit. Plain
     `gh release create` is **not** idempotent by itself; it 422s
     `already_exists` against a tag that already has a release.
   - Docker tags overwrite safely, and `:latest` can never regress on a
     rerun — it's recomputed from live origin tag state on every run, not
     cached from a prior run.

## Tag guard and prerelease detection

The pipeline is tag-driven: pushing a `v*` tag is the only routine way to
release. `workflow_dispatch` exists as a manual fallback for re-runs and takes
a `version` input, but it is not a second, looser entry point — every dispatch
goes through the same guard.

The `meta` job owns that guard, and every downstream job reads its outputs
rather than deriving anything itself:

- **Version.** The leading `v` is stripped and the remainder must match
  semver; anything else fails the job immediately.
- **Tag guard.** `meta` re-fetches the tag from origin with `--force` (the
  default checkout is shallow, and on tag runs `actions/checkout` rewrites the
  annotated tag object locally), peels it with `^{commit}`, and requires that
  commit to equal `$GITHUB_SHA`. A dispatch whose ref isn't the tagged commit
  is rejected, so a dispatch from `main` cannot republish an old version as if
  it were current.
- **Prerelease.** Any version containing `-` is a prerelease. Prereleases never
  compute `is_latest`, never take the `latest` npm dist-tag, never move
  `:latest`, and never update the Homebrew tap.
- **Latest.** `is_latest` asks whether this version is the highest stable
  `vX.Y.Z` on origin *right now*, from a live `git ls-remote` combined with the
  version being released so the very first release computes `true`. It is a
  pure function of live tag state, so re-running v0.1.0 after v0.2.0 exists
  computes `false` by construction. The `ls-remote` is a standalone guarded
  assignment: a transient failure kills the job instead of silently yielding
  "this is the highest version". The whole computation fails closed, because
  failing open is exactly the `:latest`/dist-tag/tap regression the gate exists
  to prevent.

## Deterministic tarballs

The same tag should produce the same bytes, so the checksums in `SHA256SUMS`,
the Homebrew formula, and anything a user pinned stay reproducible. Three
things make that true for the release tarballs:

- **Fixed member order and ownership.** `tar --sort=name --owner=0 --group=0
  --numeric-owner` removes the runner's filesystem order and uid/gid from the
  archive.
- **Pinned mtimes.** `--mtime=@$SOURCE_DATE_EPOCH`, where `SOURCE_DATE_EPOCH`
  is the tag commit's committer time (`git show -s --format=%ct HEAD`) — not
  build time, which would differ on every run.
- **Timestamp-free gzip.** `gzip -n` omits the embedded modification time and
  original filename from the gzip header, which otherwise change every run even
  when the tar stream is byte-identical.

Each tarball carries the binary plus `LICENSE` and `NOTICE`, and `sha256sum`
over the finished set produces the `SHA256SUMS` release asset. `install.sh`
verifies every download against it, and the Homebrew formula's per-platform
digests are rendered from it.

## macOS signing and notarization

**v0.1.0 ships ad-hoc signed and unnotarized.** Apple Developer Program
enrollment is not in place, and nothing in the release path pretends
otherwise. The user-visible consequence is narrow and documented in
[docs/distribution.md](distribution.md#verify-a-release): a tarball downloaded
through a browser carries `com.apple.quarantine`, so Gatekeeper blocks the
first run until `xattr -d com.apple.quarantine ./decant` clears it. Homebrew,
`npx`, and `install.sh` never set that attribute and are unaffected. Integrity
for this release comes from SLSA build provenance, `SHA256SUMS`, and the
`gh attestation verify` check in `install.sh`.

Ad-hoc signing is a fallback, not a skipped step: arm64 macOS refuses to
execute an unsigned Mach-O outright, so the darwin binaries are signed either
way and only the certificate behind the signature changes.

Five secrets flip the same pipeline to Developer ID signing plus notarization,
with no workflow change:

| Secret | What it is |
|---|---|
| `MACOS_CERT_P12_B64` | base64-encoded Developer ID Application certificate (`.p12`) |
| `MACOS_CERT_PASSWORD` | password for that `.p12` |
| `ASC_ISSUER_ID` | App Store Connect API key issuer ID |
| `ASC_KEY_ID` | App Store Connect API key ID |
| `ASC_KEY_P8` | App Store Connect API private key contents (`.p8`) |

Signing runs on the Linux build runner via `rcodesign` (pinned by version and
checksum, never "latest"), with `--for-notarization` to enforce the hardened
runtime and a secure timestamp, and `entitlements.plist` carrying Bun's
documented JIT entitlements. Two Apple-side details drive the shape of that
step:

- **Notarization submits a `.zip`, not the release tarball.** The Notary API
  rejects `.tar.gz`, so the job zips the binary purely to have something the
  API accepts. The `.zip` is never published; the deterministic `.tar.gz` is
  still what users download.
- **A bare Mach-O binary cannot be stapled.** Stapling attaches the
  notarization ticket to a container format (app bundle, disk image, installer
  package), and a standalone executable has nowhere to put it. So a notarized
  `decant` ships with no ticket attached, and its Gatekeeper assessment depends
  on the machine being able to check notarization status with Apple rather than
  on anything in the file. Whoever configures the Apple secrets should confirm
  the resulting binary's real behavior on a clean machine — including offline —
  before relying on notarization alone; the `smoke-darwin` job asserts only
  that `spctl` accepts the binary on a runner that does have network access.

## Determinism canary

A non-blocking job rebuilds all four targets from the same tag and diffs the
result against hashes recorded in `build`.

It diffs the **pre-signing** hashes deliberately. A Developer ID signature
embeds a secure timestamp, so signed bytes differ on every run by design; a
canary that compared post-signing hashes would be permanently red and would
tell you nothing about the build. Recording the hashes before the signing step
keeps the comparison meaningful today, when darwin binaries are only ad-hoc
signed, and keeps it meaningful unchanged once Developer ID signing is turned
on.

The job warns rather than fails because Bun does not formally guarantee
deterministic `--compile` output. Measure first; promote the canary to blocking
once it has been green across several releases.

## npm bootstrap and trusted publishing

npm trusted publishing (OIDC, no long-lived credential) can only be configured
on a package that already exists, which leaves the very first publish with
nothing to authenticate as. The bootstrap resolves that once and is then torn
down; **the credential specifics live in the private runbook, not here.**

The shape, which `release.yml` already makes visible:

1. The first publish uses a short-lived token supplied as `NPM_TOKEN`. Token
   auth on a GitHub-hosted runner still emits Sigstore provenance, so the first
   release is not provenance-free — but npm provenance hard-fails from a
   private repository, so the repo must already be public.
2. With the packages in existence, a trusted publisher is configured on each
   (org `dosu-ai`, repo `decant`, workflow `release.yml`).
3. The bootstrap credential is then removed and the token-path step deleted
   from `release.yml`, leaving OIDC as the only publish path.

**Status: completed 2026-07-27.** v0.1.0 published via the bootstrap token;
trusted publishers were then configured on all five packages (org `dosu-ai`,
repo `decant`, workflow `release.yml`, no environment, `npm publish` only),
`NPM_TOKEN` was deleted, and the bootstrap step was removed. Every release
from here publishes via OIDC.

npm is independently deprecating this path: 2FA-bypassing tokens lose account
and package management in August 2026 and direct publishing around January
2027. OIDC is the destination regardless.

### The five packages

`@dosu/decant` is the launcher; `@dosu/decant-darwin-arm64`,
`@dosu/decant-darwin-x64`, `@dosu/decant-linux-arm64`, and
`@dosu/decant-linux-x64` carry the compiled binaries. The four platform
packages publish first and the launcher last, so `optionalDependencies` always
resolve against versions that already exist.

The dist-tag (`latest`, `next`, or `previous`) is chosen at publish time from
`meta`'s outputs rather than fixed afterwards, because `npm dist-tag add` is not
OIDC-capable and would reintroduce the very credential this bootstrap exists to
remove.
