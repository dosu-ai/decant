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

Ordered — later steps assume earlier ones landed.

1. **Start Apple Developer Program enrollment first.** It has the longest lead
   time (a D-U-N-S number plus Apple review can take days to weeks), and it is
   the one bootstrap step that does *not* block v0.1.0: darwin binaries ship
   ad-hoc signed and unnotarized until it lands. Once approved, create a
   Developer ID Application certificate and an App Store Connect API key, then
   add the five secrets — the pipeline starts Developer ID-signing and
   notarizing with no workflow change. See
   [macOS signing and notarization](#macos-signing-and-notarization).
2. **Get npm access sorted.** Add a second maintainer to the `@dosu` scope (or
   convert it to an npm org) and to the unscoped `decant` package; a single
   personal-account owner is a bus-factor risk for every package decant
   publishes.
3. **Make the repo public — after a full scrub.** npm provenance hard-fails a
   publish from a private repo, and Homebrew/attestation verification need
   public assets. Flipping visibility publishes every reachable ref and tag,
   including `pre-typescript`, so run a secrets scan (gitleaks/trufflehog)
   across the full ref set first. If `pre-typescript` can't pass the scrub,
   delete it from the public repo and keep it in a private mirror instead of
   forcing it through — decant's history predates the TypeScript cutover and
   nothing on mainline depends on that tag being public.
4. **Land the release-blocking work on `main`.** The tag-driven pipeline, the
   installer, and the npm package metadata are release-blocking for v0.1.0 —
   none of them can land after the first tag as a follow-up, because the first
   tag is what publishes them. Apple signing is the deliberate exception
   (step 1).
5. **Create a bootstrap npm token.** Trusted publishers can only be configured
   on packages that already exist, so the very first publish for each of the
   six packages needs a classic-token-free bootstrap path: a granular npm
   access token with read/write package permission covering the `@dosu` scope
   *and* the unscoped `decant` package, "Bypass 2FA" checked (CI can't answer
   an OTP), and the shortest practical expiry, stored as the `NPM_TOKEN` repo
   secret. Granting npm organization access alone does not grant package
   publishing access. This path still emits npm provenance — token auth on a
   GitHub-hosted runner qualifies, provided the repo is already public. See
   [npm bootstrap and trusted publishing](#npm-bootstrap-and-trusted-publishing).
6. **Create `HOMEBREW_TOKEN`.** A fine-grained personal access token with
   Contents: read/write on `dosu-ai/homebrew-dosu`, stored as the
   `HOMEBREW_TOKEN` repo secret. `tap-update` checks out the tap with it and
   pushes `Formula/decant.rb`. Without it that job fails *after* the GitHub
   Release has already published, leaving `brew install decant` broken on a
   release the README advertises as installable that way.
7. **Tag `v0.1.0`.** The pipeline publishes all six npm packages (with
   provenance), ad-hoc signed darwin binaries, a GitHub Release with
   checksummed assets and attestations, the GHCR image, and the Homebrew tap
   formula. Immediately after the first image push, flip the new
   `ghcr.io/dosu-ai/decant` package to public and link it to the repo — a
   first-push GHCR package defaults to private even under a public repo, so an
   anonymous `docker pull` fails until this happens.
8. **Configure trusted publishers** on all six now-existing packages (org
   `dosu-ai`, repo `decant`, workflow `release.yml`, allowed action
   *Publish*). Then require 2FA and disallow tokens on publishing access for
   all six, revoke the bootstrap token, and delete the `NPM_TOKEN` secret.
   Deleting the secret is what hands the next release to the OIDC path.
9. **Verify like a user.** Before calling v0.1.0 done:
   - `npx decant@0.1.0 --version` on macOS and Linux, and once more against
     the `@dosu/decant@0.1.0` alias.
   - `brew install dosu-ai/dosu/decant` on a Mac that does not already have
     the tap.
   - The `install.sh` path end to end on both OSes.
   - `gh attestation verify` on a downloaded asset; `npm audit signatures`
     (from a scratch project with the release installed — see
     "Verify a release" in distribution.md).
   - `docker logout ghcr.io && docker pull ghcr.io/dosu-ai/decant:0.1.0`
     (anonymous — this is what catches a still-private GHCR package that an
     authenticated pull would silently mask), then a `docker run` smoke test
     against an `/api/*` route.
   - On a Mac: download a tarball in a browser, extract it, and run it. Until
     Apple enrollment lands, expect Gatekeeper to block that first run —
     `xattr -d com.apple.quarantine ./decant` clears it. Confirm the
     documented workaround actually works rather than confirming its absence.
   See [docs/distribution.md](distribution.md#verify-a-release) for the exact
   commands behind each of these checks.
10. **Tag `v0.1.1`** once you're ready, and confirm the OIDC trusted-publishing
   path publishes end to end with auto-generated provenance (keep
   `--provenance` explicit regardless — auto-generation doesn't always kick
   in in practice). v0.1.0 proved provenance works at all; v0.1.1 proves the
   token-to-OIDC handoff works.

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
   - `npx decant@$VERSION --version` (use `@latest` only when this release's
     `meta` reported it as the newest stable tag — a backport is never
     `latest` by design).
   - `curl -fsSL .../install.sh | sh` on one machine.
   - On a Mac, run the darwin tarball binary once — this catches signature
     regressions no Linux job can.
   - Confirm the release page has all four tarballs plus `SHA256SUMS`, and run
     `gh attestation verify` on one asset.
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
nothing to authenticate as. The bootstrap resolves that once, then gets torn
down:

1. **First publish, short-lived token.** A granular npm access token with
   read/write package permission covering the `@dosu` scope and the unscoped
   `decant` package, "Bypass 2FA" checked because CI cannot answer an OTP, and
   the shortest practical expiry, stored as the `NPM_TOKEN` secret. Token auth
   on a GitHub-hosted runner still emits Sigstore provenance, so v0.1.0 is not
   a provenance-free release — but npm provenance hard-fails from a private
   repo, so **the repo must already be public** before this step.
2. **Then trusted publishing.** With the packages in existence, configure a
   trusted publisher on each of the six (org `dosu-ai`, repo `decant`, workflow
   `release.yml`), then require 2FA and disallow tokens for publishing.
3. **Then revoke.** Revoke the bootstrap token and delete the `NPM_TOKEN`
   secret. The workflow selects its publish path from whether that secret is
   present, so deleting it is what hands the next release to OIDC — there is no
   second edit to remember.

The six packages are `decant` (the documented entry point), `@dosu/decant` (the
same launcher under the scope), and the four platform packages
`@dosu/decant-darwin-arm64`, `@dosu/decant-darwin-x64`,
`@dosu/decant-linux-arm64`, and `@dosu/decant-linux-x64`. The four platform
packages publish first and the launchers last, so `optionalDependencies` always
resolve against versions that already exist. The dist-tag (`latest`, `next`, or
`previous`) is chosen at publish time from `meta`'s outputs rather than fixed
afterwards, because `npm dist-tag add` is not OIDC-capable and would reintroduce
the very token this bootstrap exists to remove.
