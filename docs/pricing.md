# Pricing estimates

Decant estimates token costs at ingest using published first-party API rates.
Claude Haiku 5.5 rates, the Claude Sonnet 5.5 cache-read rate, and fast-mode
rates were verified on October 7, 2026, and all other Anthropic rates on
September 28, 2026, against the Anthropic pricing and model deprecation pages
below. GPT-6.1 Terra rates were verified on October 26, 2026, GPT-6.1 Sol
rates on September 29, 2026, GPT-6 Sol and Luna rates on September 22, 2026,
and other current OpenAI coding-agent rates retain their September 9, 2026
verification. Legacy OpenAI rates were checked September 2, 2026, and Gemini
rates September 28, 2026.
Z.ai GLM, Meta Muse, DeepSeek, Moonshot Kimi, MiniMax, Xiaomi MiMo, Alibaba
Qwen, StepFun, Tencent Hy, and Reflection Beam rates were verified on October
26, 2026. The open-weight models in that list were chosen from the
[Artificial Analysis open-weight leaderboard](https://artificialanalysis.ai/models/open-source),
which Decant uses only to decide which models to price, never as the source of
a rate.

- [Anthropic model and prompt-cache pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Claude Opus 5.5 model details](https://platform.claude.com/docs/en/models/opus-5-5/overview)
- [Claude Sonnet 5.5 model details](https://www.anthropic.com/claude-sonnet-5-5)
- [Claude Haiku 5.5 model details](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
- [Introducing Claude Haiku 5.5](https://www.anthropic.com/claude-haiku-5-5) (Haiku 5.5 rates and the Sonnet 5.5 cache-read reduction)
- [Anthropic fast mode pricing](https://platform.claude.com/docs/en/about-claude/pricing#fast-mode-pricing)
- [Anthropic model deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [OpenAI model pages](https://developers.openai.com/api/docs/models)
- [OpenAI GPT-6 Astra pricing](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [OpenAI GPT-6 Sol pricing](https://developers.openai.com/api/docs/models/gpt-6-sol)
- [OpenAI GPT-6.1 Sol pricing](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [Introducing GPT-6.1 Sol](https://openai.com/index/introducing-gpt-6-1-sol/)
- [OpenAI GPT-6.1 Terra pricing](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
- [OpenAI GPT-6 Luna pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [OpenAI Codex credit pricing](https://learn.chatgpt.com/docs/pricing)
- [OpenAI model deprecations](https://developers.openai.com/api/docs/deprecations)
- [OpenAI GPT-3.5 Turbo launch pricing](https://openai.com/index/introducing-chatgpt-and-whisper-apis/)
- [OpenAI GPT-3.5 Turbo June 2023 price update](https://openai.com/index/function-calling-and-other-api-updates/)
- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing) (checked September 28, 2026)
- [Z.ai pricing](https://docs.z.ai/guides/overview/pricing) (checked October 26, 2026)
- [Meta Model API pricing](https://dev.meta.ai/docs/pricing-rate-limits) (checked October 26, 2026)
- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/) (checked October 26, 2026)
- [Kimi API pricing](https://platform.kimi.ai/docs/pricing/chat) and [context caching](https://platform.kimi.ai/docs/guide/context-caching.md) (checked October 26, 2026)
- [MiniMax pricing](https://platform.minimax.io/docs/pricing/overview) (checked October 26, 2026)
- [Xiaomi MiMo pay-as-you-go pricing](https://mimo.mi.com/docs/en-US/price/pay-as-you-go) (checked October 26, 2026)
- [Alibaba Cloud Model Studio pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing) and [context cache](https://www.alibabacloud.com/help/en/model-studio/context-cache) (checked October 26, 2026)
- [QwenCloud Qwen3.8 2.4T A95B model page](https://www.qwencloud.com/models/qwen3.8-2.4t-a95b) (its cached-input rate, checked October 26, 2026)
- [StepFun pricing](https://platform.stepfun.ai/docs/en/guides/pricing/details) (checked October 26, 2026)
- [Tencent Cloud TokenHub model pricing](https://www.tencentcloud.com/document/product/1300/78937) (checked October 26, 2026)
- [Reflection beta pricing](https://reflection.ai/legal/beta-pricing-information) and [models](https://developers.reflection.ai/models) (checked October 26, 2026)

All dollar amounts below are USD per million tokens. A dash means that the
provider does not publish a first-party API token price for that model slug.

## Coding-agent model rates

| Provider models | Input | Cached input | Cache write | Output |
| --- | ---: | ---: | ---: | ---: |
| Claude Fable 5.1, Mythos 5.1 | $10.00 | $0.25 | $12.50 / $20.00 | $50.00 |
| Claude Fable 5, Mythos 5 | $10.00 | $1.00 | $12.50 / $20.00 | $50.00 |
| Claude Opus 5.5 | $4.00 | $0.20 | $5.00 / $8.00 | $20.00 |
| Claude Opus 5, 4.8, 4.7, 4.6, 4.5 | $5.00 | $0.50 | $6.25 / $10.00 | $25.00 |
| Claude Opus 4.1, 4 | $15.00 | $1.50 | $18.75 / $30.00 | $75.00 |
| Claude Sonnet 5.5 | $2.00 | $0.10 | $2.50 / $4.00 | $10.00 |
| Claude Sonnet 5 | $2.00 | $0.20 | $2.50 / $4.00 | $10.00 |
| Claude Sonnet 4.6, 4.5, 4 | $3.00 | $0.30 | $3.75 / $6.00 | $15.00 |
| Claude Haiku 5.5 | $0.10 | $0.01 | $0.125 / $0.20 | $0.50 |
| Claude Haiku 4.5 | $1.00 | $0.10 | $1.25 / $2.00 | $5.00 |
| Claude Haiku 3.5 | $0.80 | $0.08 | $1.00 / $1.60 | $4.00 |
| Claude Opus 3, Sonnet 3.7, 3.5, 3, Haiku 3 | — | — | — | — |
| GPT-6 Astra | $10.00 | $1.00 | $12.50 | $50.00 |
| GPT-6 Sol | $2.00 | $0.20 | $2.50 | $10.00 |
| GPT-6.1 Sol | $2.00 | $0.10 | $2.50 | $10.00 |
| GPT-6.1 Terra | $1.00 | $0.05 | $1.25 | $5.00 |
| GPT-6 Luna | $0.10 | $0.01 | $0.125 | $0.50 |
| GPT-5.6 Sol, GPT-5.6, Daybreak Blue | $4.00 | $0.40 | $5.00 | $20.00 |
| GPT-5.6 Terra | $2.00 | $0.20 | $2.50 | $12.00 |
| GPT-5.6 Luna | $0.20 | $0.02 | $0.25 | $1.20 |
| GPT-5.6 Cyber, Daybreak Red | $12.50 | $1.25 | $15.625 | $75.00 |
| GPT-5.5 | $5.00 | $0.50 | no additional fee | $30.00 |
| GPT-5.4 | $2.50 | $0.25 | no additional fee | $15.00 |
| GPT-5.4 mini | $0.75 | $0.075 | no additional fee | $4.50 |
| GPT-5.3-Codex, GPT-5.2-Codex | $1.75 | $0.175 | no additional fee | $14.00 |
| GPT-5.1-Codex, GPT-5.1-Codex-Max, GPT-5-Codex | $1.25 | $0.125 | no additional fee | $10.00 |
| GPT-5.1-Codex-mini | $0.25 | $0.025 | no additional fee | $2.00 |
| codex-mini-latest | $1.50 | $0.375 | no additional fee | $6.00 |
| codex-auto-review, GPT-5.3-Codex-Spark, GPT-5-Codex-mini, GPT-5.4-cyber | — | — | — | — |
| Gemini 3.5 Flash | $1.50 | $0.15 | $1.50-equiv | $9.00 |
| Gemini 3.5 Flash-Lite | $0.30 | $0.03 | $0.30-equiv | $2.50 |
| Gemini 3.8 Flash, 3.7 Flash, 3.6 Flash | $0.75 | $0.075 | $0.75-equiv | $3.75 |
| Gemini 3 Flash Preview | $0.50 | $0.05 | $0.50-equiv | $3.00 |
| Gemini 3.1 Pro Preview | $2.00 | $0.20 | $2.00-equiv | $12.00 |
| Gemini 3.1 Flash-Lite | $0.25 | $0.025 | $0.25-equiv | $1.50 |
| Gemini 2.5 Pro | $1.25 | $0.125 | $1.25-equiv | $10.00 |
| Gemini 2.5 Flash | $0.30 | $0.03 | $0.30-equiv | $2.50 |
| Gemini 2.5 Flash-Lite | $0.10 | $0.01 | $0.10-equiv | $0.40 |
| Gemini image, TTS, live, transcribe, native-audio, computer-use variants | — | — | — | — |
| GLM-5.3, GLM-5.2, GLM-5.1 | $1.40 | $0.26 | no additional fee | $4.40 |
| GLM-5.3-FlashX | $0.37 | $0.075 | no additional fee | $1.25 |
| GLM-5.3-Flash | $0.15 | $0.03 | no additional fee | $0.50 |
| GLM-5 | $1.00 | $0.20 | no additional fee | $3.20 |
| GLM-4.7, GLM-4.6, GLM-4.5 | $0.60 | $0.11 | no additional fee | $2.20 |
| GLM-4.5-X | $2.20 | $0.45 | no additional fee | $8.90 |
| GLM-4.5-AirX | $1.10 | $0.22 | no additional fee | $4.50 |
| GLM-4.5-Air | $0.20 | $0.03 | no additional fee | $1.10 |
| GLM-4.7-FlashX | $0.07 | $0.01 | no additional fee | $0.40 |
| GLM-4-32B-0414-128K | $0.10 | $0.10 | no additional fee | $0.10 |
| GLM-4.7-Flash, GLM-4.5-Flash | free | free | free | free |
| GLM-5.3-HighSpeed, GLM-5.2-HighSpeed, GLM-5-Turbo, GLM-5V-Turbo | — | — | — | — |
| Muse Wonder 1.0 | $4.00 | $0.20 | no additional fee | $20.00 |
| Muse Spark 1.3, 1.2, 1.1 | $1.25 | $0.15 | no additional fee | $4.25 |
| Muse Spark 1.3 Contributor, 1.2 Contributor | $0.10 | $0.002 | no additional fee | $0.20 |
| Muse Wonder Full, Muse Glimmer, Muse Image, Muse Voice | — | — | — | — |
| DeepSeek Flash (`deepseek-flash`, `deepseek-v4-flash`) | $0.30 | $0.006 | no additional fee | $1.20 |
| DeepSeek V4 Pro | $1.32 | $0.044 | no additional fee | $3.96 |
| Kimi K2.7 Code, Kimi K2.6 | $0.95 | $0.19 / $0.16 | no additional fee | $4.00 |
| Kimi K2.7 Code HighSpeed | $1.90 | $0.38 | no additional fee | $8.00 |
| MiniMax-M3 | $0.30 | $0.06 | no additional fee | $1.20 |
| MiMo-V2.6-Pro | $0.435 | $0.0036 | free | $0.87 |
| MiMo-V2.6-Flash | $0.14 | $0.0028 | free | $0.28 |
| MiMo-V2.6-Pro-UltraSpeed | $4.35 | $0.036 | free | $8.70 |
| Qwen3.8 2.4T A95B | $2.00 | $0.25 | $2.50 | $6.00 |
| Qwen3.8 27B | $0.50 | $0.10 | $0.625 | $3.00 |
| Qwen3.5 397B A17B | $0.60 | no cache | no cache | $3.60 |
| Qwen3.5 122B A10B | $0.40 | no cache | no cache | $3.20 |
| Qwen3.6 35B A3B | $0.375 | no cache | no cache | $2.25 |
| Step 5 Preview | $1.00 | $0.10 | no additional fee | $2.70 |
| Hy3 | $0.132 | $0.033 | no additional fee | $0.528 |
| Beam 1.0 | free | free | free | free |
| `deepseek-chat`, `deepseek-reasoner`, Kimi K2.5, Kimi K3 and K3.1, MiniMax M2.x, MiMo V2.5, Qwen3.8-Flash, Qwen3.8-Flash-Next, `hy3-preview` | — | — | — | — |
| Ling 3.1 Flash, Muse Spark Open, Nemotron 3.5 Super VL, Nemotron 3 Ultra, Inkling, K2 Horizon | — | — | — | — |

Claude's two cache-write figures are the 5-minute and 1-hour rates. OpenAI
cache writes before GPT-5.6 have no additional fee; GPT-5.6 and the GPT-6
and GPT-6.1 models above bill cache writes at 1.25 times the uncached-input
rate, which OpenAI lists as the 30-minute cache write. OpenAI also lists a
12-hour cache write for GPT-6 and GPT-6.1 at twice the input rate, but Codex
does not report which retention a write used, so Decant bills every write at
the 30-minute rate. Gemini bills cache storage by the token-hour, so Decant
maps the equivalent write charge to approximately the input rate for typical
session-length holds.

Z.ai and Meta charge no separate cache-write fee, so Decant bills cache writes
for GLM and Muse models at the input rate. Z.ai lists cached-input storage as
free for a limited time, so Decant adds no holding charge. Z.ai publishes
GLM-4.7-Flash and GLM-4.5-Flash as free, so Decant prices them at zero rather
than leaving them unpriced. The HighSpeed GLM models are only offered through
the GLM Coding Plan, and GLM-5-Turbo and GLM-5V-Turbo are absent from Z.ai's
pricing page, so they stay unpriced. Muse Wonder Full is only available
through a Muse Code subscription, and Muse Glimmer only through third-party
routers, so neither has a first-party API rate. OpenRouter's unversioned
`meta/muse-wonder` bills at Muse Wonder 1.0's rates, so Decant maps it there.
Router prefixes such as `z-ai/` and `meta/`, hosted routing suffixes such as
OpenRouter's `:free` and Ollama's `:cloud`, and promotional `-free` copies are
priced at the model's list rate. Other tags, such as an Ollama or LM Studio
quantization like `:q4_K_M`, name a local build with no API spend, so Decant
leaves them unpriced. The same rules apply to the DeepSeek, Kimi, MiniMax,
MiMo, Qwen, StepFun, Hy, and Beam IDs, so `moonshotai/kimi-k2.6` and
`deepseek-v4-pro:cloud` reach the list rate and `qwen3.8:27b` stays unpriced.

DeepSeek charges the rates above during peak hours, 01:00 to 04:00 and 06:00
to 10:00 UTC on weekdays, and half those rates at all other times. Decant
prices every DeepSeek request at the peak rate, so its estimates are an upper
bound. DeepSeek now serves `deepseek-v4-flash` and
`deepseek-v4-flash-vision-exp` as `deepseek-flash` at the Flash rate.
OpenRouter names the same models by the version DeepSeek serves, so
`deepseek-v4.1-flash-1017` and `deepseek-v4.1-flash` bill at the Flash rate
and `deepseek-v4-pro-0813` at the V4 Pro rate. `deepseek-chat` and
`deepseek-reasoner` were scheduled for discontinuation on July 24, 2026 and no
longer appear on the pricing page, so they stay unpriced. DeepSeek's
Anthropic-compatible endpoint maps Claude model names to DeepSeek models.
Decant prices any request recorded under a Claude ID at Claude rates, which
for those requests is far above what DeepSeek bills.

MiniMax describes the MiniMax-M3 rates above as a permanent 50% discount from
its list price, and Decant uses the discounted rates it actually charges.
Prompts above 512,000 tokens bill at twice those rates, and the Priority
service tier at 1.5 times. Decant applies neither modifier, so estimates for
those requests are low. Moonshot's Kimi K2 models do not support cache writes,
and Moonshot retires all K2 models by the end of December 2026. Kimi K3 and
K3.1 are not open-weight and are not yet priced.

Xiaomi lists MiMo cache writes as free for a limited time with no end date, so
Decant bills them at zero. Alibaba prices Qwen at the international
(Singapore) rates above. Implicit cache hits bill at the cached rate, and only
explicit caching creates a cache entry, at 125% of input. The Qwen3.5 and
Qwen3.6 open models do not support caching, so any cache reads reported for
them bill at the input rate. Qwen3.8-Flash-Next has no first-party API, and
the hosted `qwen3.8-flash` built on it is a commercial model, so neither is
priced. Reflection's Beam API is free during its beta, subject to daily
limits, so Decant prices `Beam-1.0-501B-A23B` at zero. The preview ID
`Beam-501B-A23B` is not documented as an alias and stays unpriced.

Several open-weight models with high Artificial Analysis scores have no USD
per-token first-party rate. Ant Group publishes Ling 3.1 Flash prices only in
CNY, and Decant does not convert currencies. Meta does not serve Muse Spark
Open on its Model API, and it is a separate model from Muse Spark 1.3. NVIDIA
offers Nemotron only through free trial endpoints and per-GPU licenses. The
Institute of Foundation Models publishes no price for K2 Horizon.
Thinking Machines publishes two price lists for Inkling without saying which
one applies to its Anthropic-compatible endpoint. All of these stay unpriced.

Anthropic made Claude Sonnet 5's $2.00 input and $10.00 output rates standard
on September 1, 2026, so the previously announced increase did not take
effect. Claude Sonnet 5.5 launched on September 28, 2026 at the same rates as
Sonnet 5. Anthropic halved its cache-read rate to $0.10 starting October 7,
2026, per the Claude Haiku 5.5 announcement; the pricing page's model table
still listed $0.20 when checked that day. Claude Opus 5.5 has a lower input,
output, and cache-read rate than Opus 5. Claude Haiku 5.5 launched on October
7, 2026 with prompt-length pricing: the rates above apply to prompts up to
100,000 tokens, and every rate is five times higher for longer prompts. Claude Fable 5.1 and Mythos 5.1 keep
Fable 5's input, cache-write, and output rates but reduce cache reads from
$1.00 to $0.25. OpenAI describes the
current GPT-5.6 Sol rate as promotional through at least November 21, 2026.
Google's Gemini 3.8 Flash, 3.7 Flash, and 3.6 Flash listed above carry a promotional rate
through December 31, 2026; they rise to $1.50 input / $0.15 cached / $7.50
output on January 1, 2027. Google no longer lists the Gemini 2.0 line or Gemini 3
Pro Preview on the pricing page, and Gemini versions without a published rate stay unpriced
rather than inheriting a neighbor's rate.

Claude 3 model IDs such as `claude-3-5-haiku-20241022` place the tier after
the version, so Decant recognizes that form as well as tier-first IDs like
`claude-haiku-4-5`. Anthropic's pricing page no longer lists the fully retired
Claude Opus 3, Sonnet 3.7, Sonnet 3.5, Sonnet 3, or Haiku 3, so Decant leaves
them unpriced instead of assigning a current tier's rate. Haiku 3.5, Opus 4.1,
Opus 4, and Sonnet 4 are retired on the Claude API but remain listed because
partner clouds still serve them.

`codex-auto-review` is a hidden routing slug, not a public billable model ID.
OpenAI does not document which underlying model or rate applies. Decant leaves
it and other unpublished Codex slugs unpriceable instead of guessing a nearby
model's price.

For `gpt-3.5-turbo-0301`, Decant uses the final published GPT-3.5 Turbo rate
of $1.50 input and $2.00 output. OpenAI's current deprecations table displays
$15.00 and $20.00, but those figures conflict with the contemporaneous launch
and June 2023 pricing announcements linked above.

## Request tiers

Decant prices each API request at the model that served it, and applies two
request-level modifiers where the source records what they need:

- **Fast mode.** A Claude request whose usage reports `speed: "fast"` is billed
  at twice the standard rate for every token category, cache reads and writes
  included, on Claude Opus 5.5 ($8.00 input / $40.00 output), Opus 5, and Opus
  4.8 ($10.00 / $50.00). Opus 4.6 bills fast requests at standard rates.
- **Claude Haiku 5.5 long prompts.** A request whose prompt (uncached input
  plus cache reads and cache writes) exceeds 100,000 tokens is billed at five
  times every rate above.

Sources without per-request usage, such as Codex rollouts, are priced from
session totals at the session's model and standard rates.

## Scope and historical behavior

The estimates use standard global API token rates. They do not attempt to
convert ChatGPT subscription usage or Codex credits to dollars, and they do not
apply Batch, Flex, Priority, regional-processing, data-residency, or
partner-cloud modifiers. Requests made through subscription routes such as the
GLM Coding Plan are estimated at the model's API list rate.

OpenAI applies long-context rates above 272,000 prompt tokens for eligible API
models. Codex reports cumulative session usage rather than per-request usage,
so Decant cannot tell whether an individual request crossed that threshold.
These estimates use short-context rates and may be low for qualifying
requests. Claude 4.6 and later models other than Haiku 5.5 include their full
context window at the standard rate.

Costs are stored when transcripts are ingested and checked against current
pricing on every sync, including unchanged and archived sessions. Sync updates
stale session costs and persisted activity cost components together without
rereading transcripts or replacing user metadata. Later syncs leave matching
costs untouched.

OpenCode sessions are priced with Decant's first-party rates whenever the model
is supported, including the GLM, Muse, and other lab rates above. For a model
Decant cannot price, Decant falls back to the per-request cost OpenCode
recorded (the reported cost). A recorded cost of 0 leaves the model unpriced,
and a model that later gains a Decant rate switches back to Decant pricing.
Each session carries a `cost_source` label:

- `decant`: priced entirely with Decant's rates.
- `reported`: priced only with costs OpenCode recorded.
- `mixed`: some models priced by Decant and others by reported cost.

Aggregate dollar totals therefore include Decant's estimates for supported
models, plus reported costs for OpenCode sessions with models Decant cannot
price. Reported costs are not first-party estimates, and token-economics totals
report them separately as `reported_cost_usd`.
