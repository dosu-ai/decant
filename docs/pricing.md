# Pricing estimates

Decant estimates token costs at ingest using published first-party API rates.
The seed table was last verified on July 25, 2026 against:

- [Anthropic model and prompt-cache pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [OpenAI model pages](https://developers.openai.com/api/docs/models)
- [OpenAI Codex pricing](https://developers.openai.com/codex/pricing)
- [OpenAI model deprecations](https://developers.openai.com/api/docs/deprecations)
- [OpenAI GPT-3.5 Turbo launch pricing](https://openai.com/index/introducing-chatgpt-and-whisper-apis/)
- [OpenAI GPT-3.5 Turbo June 2023 price update](https://openai.com/index/function-calling-and-other-api-updates/)

All dollar amounts below are USD per million tokens. A dash means that the
provider does not publish a first-party API token price for that model slug.

## Coding-agent model rates

| Provider models | Input | Cached input | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| Claude Fable 5, Mythos 5 | $10.00 | $1.00 | $12.50 / $20.00 | $50.00 |
| Claude Opus 5, 4.8, 4.7, 4.6, 4.5 | $5.00 | $0.50 | $6.25 / $10.00 | $25.00 |
| Claude Opus 4.1, 4 | $15.00 | $1.50 | $18.75 / $30.00 | $75.00 |
| Claude Sonnet 5 through August 31, 2026 | $2.00 | $0.20 | $2.50 / $4.00 | $10.00 |
| Claude Sonnet 4.6, 4.5, 4 | $3.00 | $0.30 | $3.75 / $6.00 | $15.00 |
| Claude Haiku 4.5 | $1.00 | $0.10 | $1.25 / $2.00 | $5.00 |
| Claude Haiku 3.5 | $0.80 | $0.08 | $1.00 / $1.60 | $4.00 |
| GPT-5.6 Sol | $5.00 | $0.50 | $6.25 | $30.00 |
| GPT-5.6 Terra | $2.50 | $0.25 | $3.125 | $15.00 |
| GPT-5.6 Luna | $1.00 | $0.10 | $1.25 | $6.00 |
| GPT-5.5 | $5.00 | $0.50 | no additional fee | $30.00 |
| GPT-5.4 | $2.50 | $0.25 | no additional fee | $15.00 |
| GPT-5.4 mini | $0.75 | $0.075 | no additional fee | $4.50 |
| GPT-5.3-Codex, GPT-5.2-Codex | $1.75 | $0.175 | no additional fee | $14.00 |
| GPT-5.1-Codex, GPT-5.1-Codex-Max, GPT-5-Codex | $1.25 | $0.125 | no additional fee | $10.00 |
| GPT-5.1-Codex-mini | $0.25 | $0.025 | no additional fee | $2.00 |
| codex-mini-latest | $1.50 | $0.375 | no additional fee | $6.00 |
| codex-auto-review, GPT-5.3-Codex-Spark, GPT-5-Codex-mini, GPT-5.4-cyber | — | — | — | — |

Claude's two cache-write figures are the 5-minute and 1-hour rates. OpenAI
cache writes before GPT-5.6 have no additional fee; GPT-5.6 reports and bills
cache writes at 1.25 times the uncached-input rate.

`codex-auto-review` is a hidden routing slug, not a public billable model ID.
OpenAI does not document which underlying model or rate applies. Decant leaves
it and other unpublished Codex slugs unpriceable instead of guessing a nearby
model's price.

For `gpt-3.5-turbo-0301`, Decant uses the final published GPT-3.5 Turbo rate
of $1.50 input and $2.00 output. OpenAI's current deprecations table displays
$15.00 and $20.00, but those figures conflict with the contemporaneous launch
and June 2023 pricing announcements linked above.

## Scope and historical behavior

The estimates use standard global API token rates. They do not attempt to
convert ChatGPT subscription usage or Codex credits to dollars, and they do not
apply Batch, Flex, Priority, fast-mode, regional-processing, data-residency, or
partner-cloud modifiers.

OpenAI applies long-context rates above 272,000 prompt tokens for eligible API
models. The Codex model catalog currently caps coding-agent context at 272,000
tokens, so Decant's Codex sources do not cross that threshold. Claude 4.6 and
later include their full context window at the standard rate.

Costs are stored on the session row when the transcript is ingested. Updating
the seed table does not rewrite historical rows; rebuild the archive to
re-estimate existing sessions with a newer pricing table.
