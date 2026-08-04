---
name: pr-review
description: Review a pull request in the decant house style and post it with gh. Use when asked to review, audit, or leave review comments on a decant PR, when drafting review feedback on another contributor's changes, or when posting review text under a maintainer's name.
---

# Reviewing a pull request

The canonical workflow is `docs/prompts/review-pr.md`. Read it and work
through it top to bottom. It owns the voice rules, the severity callouts, the
verification bar, suggestion-block mechanics, and the posting steps. The
voice rules are hard requirements for posted text, not decoration.

Keep these anchors in mind while you work.

- Verify every finding against the PR head, not local `main`, and reproduce
  bugs on a scratch archive (`--db` to a scratch path plus `--no-sync` on
  reads), never the real one.
- Every comment leads with a native callout tier. CAUTION Critical blocks
  the merge, WARNING High rides with the blocking fix, IMPORTANT Medium
  should land, NOTE Low is optional, and TIP is the single 🎉 Kudos each
  review should carry when the code earns it.
- Posted prose uses no em dashes, colons, or semicolons. Thank the author by
  @handle, never approve unless explicitly told to, and never add an AI
  attribution footer to review text.
- Mechanical fixes ship as one-click suggestion blocks built from the head
  files so indentation is exact, and heads move mid-review here, so re-check
  `headRefOid` right before posting.

## Gate

A review changes no code, so the gate is on what you post. Every suggestion
block must leave `bun test`, `bunx tsc --noEmit`, and `bunx biome check .`
green if applied, and every claim must have survived verification on the PR
head.
