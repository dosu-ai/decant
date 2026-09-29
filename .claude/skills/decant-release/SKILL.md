---
name: decant-release
description: Cut a Decant release (signed vX.Y.Z tag that triggers the release workflow for GitHub Releases, npm, GHCR, and the Homebrew tap). Use when asked to release, tag, or publish Decant, or to check whether main is ready to release.
---

# Release Decant

Publishing is irreversible: npm versions cannot be reused and the Homebrew tap
updates for every user.

**Stop and ask the user for explicit approval before running `just release`,
pushing any tag, dispatching `release.yml`, merging with `--admin`, or
re-running a release job.** An earlier approval in the same conversation does
not cover a new tag.

## Preflight

1. On `main`, clean tree, up to date with `origin/main`.
2. `just check` passes locally (needs network for the npm pack smoke).
3. CI is green on the exact commit you will tag.
4. Pick the version: semver without a leading `v`. Prerelease suffixes such as
   `-beta.1` and backport tags below the newest release publish to narrower
   channels; `docs/distribution.md` describes which.

## Tag

`just release VERSION` re-checks step 1 of the preflight only, then creates a
signed annotated tag `vVERSION` and pushes it, so the approval above must come
first. Signing is required; do not bypass it.

## What the tag triggers

`.github/workflows/release.yml` builds the platform binaries (codesigned when
signing secrets are configured), attests them, publishes GitHub Release assets
with `SHA256SUMS`, publishes the npm launcher and platform packages with
provenance, pushes the GHCR image, and updates the formula in
`dosu-ai/homebrew-dosu`.

## Afterwards

Follow "Verify a release" in `docs/distribution.md` (checksums,
`gh attestation verify`, `npm audit signatures`) and report the results. If a
job fails, report the failing step and wait for the user before re-running or
retagging.
