# Releasing decant

Audience: a maintainer cutting a decant release. This is a condensed runbook
for the tag-driven release pipeline decant's automation is designed around;
it has two parts — a one-time bootstrap that happens once, before the first
tag, and the steady-state process every release after that follows.

Distribution channels and per-artifact verification live in
[docs/distribution.md](distribution.md); this doc is about the process of
cutting a release, not the shape of what gets published.

## One-time bootstrap

Ordered — later steps assume earlier ones landed.

1. **Start Apple Developer Program enrollment first.** It has the longest lead
   time (a D-U-N-S number plus Apple review can take days to weeks). Once
   approved: create a Developer ID Application certificate, an App Store
   Connect API key for notarization, add the signing secrets to the repo, and
   commit an `entitlements.plist` with Bun's documented JIT entitlements.
   macOS binaries are Developer ID-signed and notarized starting at v0.1.0 —
   this step is what makes that true.
2. **Get npm access sorted.** Add a second maintainer to the `@dosu` scope (or
   convert it to an npm org); a single personal-account owner is a bus-factor
   risk for every `@dosu` package, not just decant's.
3. **Make the repo public — after a full scrub.** npm provenance hard-fails a
   publish from a private repo, and Homebrew/attestation verification need
   public assets. Flipping visibility publishes every reachable ref and tag,
   including `pre-typescript`, so run a secrets scan (gitleaks/trufflehog)
   across the full ref set first. If `pre-typescript` can't pass the scrub,
   delete it from the public repo and keep it in a private mirror instead of
   forcing it through — decant's history predates the TypeScript cutover and
   nothing on mainline depends on that tag being public.
4. **Land the release-blocking work on `main`.** The tag-driven pipeline, the
   signing/notarization plumbing, the npm package READMEs, and the UI
   loading-architecture cleanup are all release-blocking for v0.1.0 — none of
   them can land after the first tag as a follow-up.
5. **Create a bootstrap npm token.** Trusted publishers can only be configured
   on packages that already exist, so the very first publish for each of the
   five `@dosu/decant*` packages needs a classic-token-free bootstrap path: a
   granular npm access token scoped to those packages, with "Bypass 2FA"
   checked (CI can't answer an OTP) and the default 7-day expiry, stored as a
   repo secret. This path still emits npm provenance — token auth on a
   GitHub-hosted runner qualifies, provided the repo is already public.
6. **Tag `v0.1.0`.** The pipeline publishes all five npm packages (with
   provenance), signed and notarized darwin binaries, a GitHub Release with
   checksummed assets and attestations, and the GHCR image. Immediately after
   the first image push, flip the new `ghcr.io/dosu-ai/decant` package to
   public and link it to the repo — a first-push GHCR package defaults to
   private even under a public repo, so an anonymous `docker pull` fails until
   this happens.
7. **Configure trusted publishers** on all five now-existing packages (org
   `dosu-ai`, repo `decant`, workflow `release.yml`, allowed action
   *Publish*). Then require 2FA and disallow tokens on publishing access for
   all five, and revoke the bootstrap token.
8. **Verify like a user.** Before calling v0.1.0 done:
   - `npx @dosu/decant@0.1.0 --version` on macOS and Linux.
   - The `install.sh` path end to end on both OSes.
   - `gh attestation verify` on a downloaded asset; `npm audit signatures`
     (from a scratch project with the release installed — see
     "Verify a release" in distribution.md).
   - `docker logout ghcr.io && docker pull ghcr.io/dosu-ai/decant:0.1.0`
     (anonymous — this is what catches a still-private GHCR package that an
     authenticated pull would silently mask), then a `docker run` smoke test
     against an `/api/*` route.
   - On a Mac: download a tarball in a browser, extract it in Finder, and run
     it. Notarization means no Gatekeeper block; `spctl -a -t exec -vv
     ./decant` should report "Notarized Developer ID".
   See [docs/distribution.md](distribution.md#verify-a-release) for the exact
   commands behind each of these checks.
9. **Tag `v0.1.1`** once you're ready, and confirm the OIDC trusted-publishing
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
   meta (guard) -> verify -> build (+sign/notarize +attest) -> smoke-darwin
     -> npm (OIDC) -> github-release -> tap-update (optional)
     -> docker (fans out in parallel, once smoke-darwin passes)
   ```

   `meta` derives and guards the version (rejects a `workflow_dispatch` whose
   ref isn't the tagged commit) and computes whether this is the newest
   stable release — the single source of truth every downstream job reads for
   `:latest`, the npm dist-tag, and the tap update. `smoke-darwin` is a gate,
   not an observer: nothing publishes until the signed darwin binary passes
   it.
4. Spot-check after the run finishes:
   - `npx @dosu/decant@$VERSION --version` (use `@latest` only when this
     release's `meta` reported it as the newest stable tag — a backport is
     never `latest` by design).
   - `curl -fsSL .../install.sh | sh` on one machine.
   - On a Mac, run the darwin tarball binary once — this catches signature
     regressions no Linux job can.
   - Confirm the release page has all four tarballs plus `SHA256SUMS`, and run
     `gh attestation verify` on one asset.
   - `brew upgrade decant` if you track the optional tap.
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
