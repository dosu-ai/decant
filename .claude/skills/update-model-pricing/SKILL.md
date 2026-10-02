---
name: update-model-pricing
description: Add or change model token rates in Decant. Use when a provider publishes new pricing, a new model needs a rate, a model ID pattern fails to match, or a retired model should stop inheriting a current tier's price.
---

# Update model pricing

Rates live in `src/cost.ts` and are documented in `docs/pricing.md`. AGENTS.md
invariant 4 explains why stored costs follow current rates.

## Steps

1. Verify every rate against the provider's first-party pricing page. Do not
   use third-party aggregators or memory.
2. Edit the pricing table and model-ID patterns in `src/cost.ts`. Retired
   models without a published rate stay unpriced rather than falling through to
   a newer tier.
3. Update `docs/pricing.md`: the table row, the source link list, and the dated
   "verified on" sentence at the top.
4. Add cases to `test/cost.test.ts` for each new or changed pattern, including
   dated-suffix variants of the model ID.
5. If context-window sizes changed too, update the model window tests in
   `test/context-window.test.ts`.

## What happens to existing archives

Every sync reprices stored session and activity costs with current rates, so a
rate change needs no migration. Bump `INGEST_PIPELINE_REVISION` only when
unchanged sources must be re-derived, for example when session model selection
changes which model a session is attributed to.

## Goldens

Golden outputs that include cost change when a fixture model's rate changes.
Review that diff line by line, then regenerate with
`bun run scripts/regen-goldens.ts --i-reviewed-the-diff`.

## Prior art

`git log --oneline -- src/cost.ts docs/pricing.md` shows earlier pricing
changes and the tests that shipped with them.
