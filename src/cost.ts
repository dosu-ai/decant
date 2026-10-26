import type { TokenUsage } from "./model.ts";

export interface Price {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
  /** Rate for cache writes made with a 1-hour TTL. */
  cacheWrite1hPerMtok: number;
}

function claudePrice(
  inputPerMtok: number,
  outputPerMtok: number,
  cacheReadMultiplier = 0.1,
): Price {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok: inputPerMtok * cacheReadMultiplier,
    cacheWritePerMtok: inputPerMtok * 1.25,
    cacheWrite1hPerMtok: inputPerMtok * 2.0,
  };
}

function openAiPrice(
  inputPerMtok: number,
  cacheReadPerMtok: number | null,
  outputPerMtok: number,
  cacheWriteMultiplier = 1,
): Price {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok: cacheReadPerMtok ?? inputPerMtok,
    cacheWritePerMtok: inputPerMtok * cacheWriteMultiplier,
    cacheWrite1hPerMtok: inputPerMtok * cacheWriteMultiplier,
  };
}

// Gemini bills cache storage by the token-hour instead of a flat write, so for
// a typical session the write-plus-hold cost lands near the input rate per
// token. The docs list both prices; Decant maps cache writes to the input rate.
function geminiPrice(inputPerMtok: number, cacheReadPerMtok: number, outputPerMtok: number): Price {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok,
    cacheWritePerMtok: inputPerMtok,
    cacheWrite1hPerMtok: inputPerMtok,
  };
}

// First-party text rates per 1M tokens for models from labs other than
// Anthropic, OpenAI, and Google, matched by exact normalized ID. Like OpenAI's
// models before GPT-5.6, most of these labs charge no separate cache-write fee,
// so `openAiPrice` bills cache writes as ordinary input. Published-free models
// are a price of zero, not an unknown price.
const EXACT_ID_PRICES: ReadonlyArray<readonly [string, Price]> = [
  // Z.ai (docs.z.ai) and Meta Model API (dev.meta.ai).
  ["glm-5.3", openAiPrice(1.4, 0.26, 4.4)],
  ["glm-5.2", openAiPrice(1.4, 0.26, 4.4)],
  ["glm-5.1", openAiPrice(1.4, 0.26, 4.4)],
  ["glm-5.3-flashx", openAiPrice(0.37, 0.075, 1.25)],
  ["glm-5.3-flash", openAiPrice(0.15, 0.03, 0.5)],
  ["glm-5", openAiPrice(1.0, 0.2, 3.2)],
  ["glm-4.7", openAiPrice(0.6, 0.11, 2.2)],
  ["glm-4.6", openAiPrice(0.6, 0.11, 2.2)],
  ["glm-4.5", openAiPrice(0.6, 0.11, 2.2)],
  ["glm-4.5-x", openAiPrice(2.2, 0.45, 8.9)],
  ["glm-4.5-airx", openAiPrice(1.1, 0.22, 4.5)],
  ["glm-4.5-air", openAiPrice(0.2, 0.03, 1.1)],
  ["glm-4.7-flashx", openAiPrice(0.07, 0.01, 0.4)],
  ["glm-4-32b-0414-128k", openAiPrice(0.1, null, 0.1)],
  ["glm-4.7-flash", openAiPrice(0, 0, 0)],
  ["glm-4.5-flash", openAiPrice(0, 0, 0)],
  ["muse-wonder-1.0", openAiPrice(4.0, 0.2, 20.0)],
  ["muse-spark-1.3", openAiPrice(1.25, 0.15, 4.25)],
  ["muse-spark-1.2", openAiPrice(1.25, 0.15, 4.25)],
  ["muse-spark-1.1", openAiPrice(1.25, 0.15, 4.25)],
  ["muse-spark-1.3-contributor", openAiPrice(0.1, 0.002, 0.2)],
  ["muse-spark-1.2-contributor", openAiPrice(0.1, 0.002, 0.2)],
  // DeepSeek bills these peak-hour rates on weekday mornings and afternoons
  // (Beijing time) and half of them otherwise. Decant prices every request at
  // the peak rate. `deepseek-v4-flash` and its vision alias now serve and bill
  // as `deepseek-flash`.
  ["deepseek-flash", openAiPrice(0.3, 0.006, 1.2)],
  ["deepseek-v4-flash", openAiPrice(0.3, 0.006, 1.2)],
  ["deepseek-v4-flash-vision-exp", openAiPrice(0.3, 0.006, 1.2)],
  ["deepseek-v4-pro", openAiPrice(1.32, 0.044, 3.96)],
  // Moonshot's K2 models cannot write a cache, and HighSpeed has its own rate.
  ["kimi-k2.7-code", openAiPrice(0.95, 0.19, 4.0)],
  ["kimi-k2.7-code-highspeed", openAiPrice(1.9, 0.38, 8.0)],
  ["kimi-k2.6", openAiPrice(0.95, 0.16, 4.0)],
  // MiniMax's standard tier for prompts up to 512K tokens, at the "permanent"
  // 50% discount it actually charges.
  ["minimax-m3", openAiPrice(0.3, 0.06, 1.2)],
  // Xiaomi lists MiMo cache writes as free for a limited time.
  ["mimo-v2.6-pro", openAiPrice(0.435, 0.0036, 0.87, 0)],
  ["mimo-v2.6-flash", openAiPrice(0.14, 0.0028, 0.28, 0)],
  ["mimo-v2.6-pro-ultraspeed", openAiPrice(4.35, 0.036, 8.7, 0)],
  // Alibaba Cloud Model Studio, international (Singapore) rates. Implicit cache
  // hits bill at the cached rate below; only explicit caching creates a cache
  // entry, at 125% of input. The Qwen3.5 and Qwen3.6 open models have no cache.
  ["qwen3.8-2.4t-a95b", openAiPrice(2.0, 0.25, 6.0, 1.25)],
  ["qwen3.8-27b", openAiPrice(0.5, 0.1, 3.0, 1.25)],
  ["qwen3.5-397b-a17b", openAiPrice(0.6, null, 3.6)],
  ["qwen3.5-122b-a10b", openAiPrice(0.4, null, 3.2)],
  ["qwen3.6-35b-a3b", openAiPrice(0.375, null, 2.25)],
  ["step-5-preview", openAiPrice(1.0, 0.1, 2.7)],
  ["hy3", openAiPrice(0.132, 0.033, 0.528)],
  // Reflection's API is free during its beta, subject to daily limits.
  ["beam-1.0-501b-a23b", openAiPrice(0, 0, 0)],
];
const EXACT_ID_KEYS: ReadonlySet<string> = new Set(EXACT_ID_PRICES.map(([model]) => model));

// These IDs arrive through router prefixes (`z-ai/`, `meta/`, `deepseek/`,
// `moonshotai/`), hosted routing variants (OpenRouter's `:free` or `:nitro`,
// Ollama's `:cloud`), Claude Code's `[1m]` marker, dated snapshots, and
// promotional `-free` copies that Decant prices at list rate like any route.
// Other `:tags` name a local Ollama or LM Studio build, which incurs no API
// spend, so they stay unpriced. Matching the whole normalized ID rather than a
// prefix keeps `-highspeed`, `-turbo`, and `muse-wonder-full` from inheriting a
// neighbor's rate. Only the last path segment names the model, so a proxy
// prefix such as `kimi-proxy/claude-opus-5-5` still reaches the Claude rates.
const EXACT_ID_FAMILY = /^(?:glm-|muse-|deepseek-|kimi-|minimax-|mimo-|qwen\d|step-\d|hy\d|beam-)/;
const HOSTED_ROUTE_SUFFIX = /:(?:free|nitro|floor|online|extended|beta|thinking|exacto|cloud)$/;
// OpenRouter's unversioned `meta/muse-wonder` bills exactly at Muse Wonder
// 1.0's rates (verified against recorded costs on 2026-10-12).
// OpenRouter names DeepSeek models by the version DeepSeek serves behind its
// API IDs, so the V4.1 Flash and V4 Pro 0813 slugs bill at those IDs' rates.
const EXACT_ID_ALIASES: ReadonlyMap<string, string> = new Map([
  ["muse-wonder", "muse-wonder-1.0"],
  ["deepseek-v4.1-flash", "deepseek-flash"],
  ["deepseek-v4.1-flash-1017", "deepseek-flash"],
  ["deepseek-v4-pro-0813", "deepseek-v4-pro"],
]);

function exactIdModel(model: string): string | null {
  const id = model
    .slice(model.lastIndexOf("/") + 1)
    .replace(/\[[^\]]*\]$/, "")
    .replace(HOSTED_ROUTE_SUFFIX, "")
    .replace(/-free$/, "")
    .replace(/-\d{6,8}$/, "");
  const key = EXACT_ID_ALIASES.get(id) ?? id;
  return EXACT_ID_KEYS.has(key) ? key : null;
}

let pricingTable: ReadonlyMap<string, Price> | null = null;

/** Built once; sync and every ingested session read it, so callers share one table. */
export function defaultPricing(): ReadonlyMap<string, Price> {
  pricingTable ??= buildDefaultPricing();
  return pricingTable;
}

function buildDefaultPricing(): Map<string, Price> {
  // Standard first-party API text-token rates per 1M tokens. Claude cache writes
  // carry both a 5-minute (1.25x input) and a 1-hour (2x input) rate; the split
  // comes from usage.cache_creation.ephemeral_{5m,1h}_input_tokens. Rates and
  // exclusions were checked against the official sources in docs/pricing.md.
  return new Map<string, Price>([
    ["claude-fable-5-1", claudePrice(10.0, 50.0, 0.025)],
    ["claude-fable", claudePrice(10.0, 50.0)],
    ["claude-opus-5-5", claudePrice(4.0, 20.0, 0.05)],
    ["claude-opus", claudePrice(5.0, 25.0)],
    ["claude-opus-4.1", claudePrice(15.0, 75.0)],
    ["claude-opus-4", claudePrice(15.0, 75.0)],
    ["claude-sonnet-5-5", claudePrice(2.0, 10.0, 0.05)],
    ["claude-sonnet-5", claudePrice(2.0, 10.0)],
    ["claude-sonnet", claudePrice(3.0, 15.0)],
    ["claude-haiku-5-5", claudePrice(0.1, 0.5)],
    ["claude-haiku", claudePrice(1.0, 5.0)],
    ["claude-haiku-3.5", claudePrice(0.8, 4.0)],
    ["gpt-6-astra", openAiPrice(10.0, 1.0, 50.0, 1.25)],
    ["gpt-6-sol", openAiPrice(2.0, 0.2, 10.0, 1.25)],
    ["gpt-6.1-sol", openAiPrice(2.0, 0.1, 10.0, 1.25)],
    ["gpt-6.1-terra", openAiPrice(1.0, 0.05, 5.0, 1.25)],
    ["gpt-6-luna", openAiPrice(0.1, 0.01, 0.5, 1.25)],
    ["gpt-5.6-sol", openAiPrice(4.0, 0.4, 20.0, 1.25)],
    ["gpt-5.6-terra", openAiPrice(2.0, 0.2, 12.0, 1.25)],
    ["gpt-5.6-luna", openAiPrice(0.2, 0.02, 1.2, 1.25)],
    ["gpt-5.6-cyber", openAiPrice(12.5, 1.25, 75.0, 1.25)],
    ["gpt-5.5", openAiPrice(5.0, 0.5, 30.0)],
    ["gpt-5.5-pro", openAiPrice(30.0, null, 180.0)],
    ["gpt-5.4", openAiPrice(2.5, 0.25, 15.0)],
    ["gpt-5.4-mini", openAiPrice(0.75, 0.075, 4.5)],
    ["gpt-5.4-nano", openAiPrice(0.2, 0.02, 1.25)],
    ["gpt-5.4-pro", openAiPrice(30.0, null, 180.0)],
    ["gpt-5.3-codex", openAiPrice(1.75, 0.175, 14.0)],
    ["gpt-5.2-codex", openAiPrice(1.75, 0.175, 14.0)],
    ["gpt-5.2", openAiPrice(1.75, 0.175, 14.0)],
    ["gpt-5.2-pro", openAiPrice(21.0, null, 168.0)],
    ["gpt-5.1-codex-max", openAiPrice(1.25, 0.125, 10.0)],
    ["gpt-5.1-codex-mini", openAiPrice(0.25, 0.025, 2.0)],
    ["gpt-5.1-codex", openAiPrice(1.25, 0.125, 10.0)],
    ["gpt-5.1", openAiPrice(1.25, 0.125, 10.0)],
    ["gpt-5-codex", openAiPrice(1.25, 0.125, 10.0)],
    ["gpt-5", openAiPrice(1.25, 0.125, 10.0)],
    ["gpt-5-mini", openAiPrice(0.25, 0.025, 2.0)],
    ["gpt-5-nano", openAiPrice(0.05, 0.005, 0.4)],
    ["gpt-5-pro", openAiPrice(15.0, null, 120.0)],
    ["codex-mini-latest", openAiPrice(1.5, 0.375, 6.0)],
    ["gpt-4.1", openAiPrice(2.0, 0.5, 8.0)],
    ["gpt-4.1-mini", openAiPrice(0.4, 0.1, 1.6)],
    ["gpt-4.1-nano", openAiPrice(0.1, 0.025, 0.4)],
    ["gpt-4o", openAiPrice(2.5, 1.25, 10.0)],
    ["gpt-4o-2024-05-13", openAiPrice(5.0, null, 15.0)],
    ["gpt-4o-mini", openAiPrice(0.15, 0.075, 0.6)],
    ["o1", openAiPrice(15.0, 7.5, 60.0)],
    ["o1-pro", openAiPrice(150.0, null, 600.0)],
    ["o3-pro", openAiPrice(20.0, null, 80.0)],
    ["o3", openAiPrice(2.0, 0.5, 8.0)],
    ["o4-mini", openAiPrice(1.1, 0.275, 4.4)],
    ["o3-mini", openAiPrice(1.1, 0.55, 4.4)],
    ["o1-mini", openAiPrice(1.1, 0.55, 4.4)],
    ["gpt-4-turbo-2024-04-09", openAiPrice(10.0, null, 30.0)],
    ["gpt-4-0125-preview", openAiPrice(10.0, null, 30.0)],
    ["gpt-4-1106-preview", openAiPrice(10.0, null, 30.0)],
    ["gpt-4-1106-vision-preview", openAiPrice(10.0, null, 30.0)],
    ["gpt-4-0613", openAiPrice(30.0, null, 60.0)],
    ["gpt-4-0314", openAiPrice(30.0, null, 60.0)],
    ["gpt-4-32k", openAiPrice(60.0, null, 120.0)],
    ["gpt-3.5-turbo", openAiPrice(0.5, null, 1.5)],
    ["gpt-3.5-turbo-0125", openAiPrice(0.5, null, 1.5)],
    ["gpt-3.5-turbo-1106", openAiPrice(1.0, null, 2.0)],
    ["gpt-3.5-turbo-0613", openAiPrice(1.5, null, 2.0)],
    ["gpt-3.5-turbo-0301", openAiPrice(1.5, null, 2.0)],
    ["gpt-3.5-turbo-instruct", openAiPrice(1.5, null, 2.0)],
    ["gpt-3.5-turbo-16k-0613", openAiPrice(3.0, null, 4.0)],
    ["davinci-002", openAiPrice(2.0, null, 2.0)],
    ["babbage-002", openAiPrice(0.4, null, 0.4)],
    // Gemini text rates (standard paid tier, per 1M tokens, ≤200k prompt).
    // 3.8-flash, 3.7-flash, and 3.6-flash carry a promo price through 2026-12-31.
    ["gemini-3.8-flash", geminiPrice(0.75, 0.075, 3.75)],
    ["gemini-3.7-flash", geminiPrice(0.75, 0.075, 3.75)],
    ["gemini-3.6-flash", geminiPrice(0.75, 0.075, 3.75)],
    ["gemini-3.5-flash", geminiPrice(1.5, 0.15, 9.0)],
    ["gemini-3.5-flash-lite", geminiPrice(0.3, 0.03, 2.5)],
    ["gemini-3.1-flash-lite", geminiPrice(0.25, 0.025, 1.5)],
    ["gemini-3-flash-preview", geminiPrice(0.5, 0.05, 3.0)],
    ["gemini-3.1-pro", geminiPrice(2.0, 0.2, 12.0)],
    ["gemini-2.5-pro", geminiPrice(1.25, 0.125, 10.0)],
    ["gemini-2.5-flash-lite", geminiPrice(0.1, 0.01, 0.4)],
    ["gemini-2.5-flash", geminiPrice(0.3, 0.03, 2.5)],
    ...EXACT_ID_PRICES,
  ]);
}

function canonicalModel(raw: string): string | null {
  const model = raw.toLowerCase().replace(/^openai[/:]/, "");
  if (EXACT_ID_FAMILY.test(model.slice(model.lastIndexOf("/") + 1))) {
    return exactIdModel(model);
  }

  if (
    model.includes("claude") ||
    model === "opus" ||
    model === "sonnet" ||
    model === "haiku" ||
    model === "fable"
  ) {
    // Claude 3 IDs put the tier after the version, so the tier checks below
    // would bill them at current rates. Haiku 3.5 is the only one still listed.
    if (/claude-3(?:[-.][57])?-(?:opus|sonnet)|claude-3-haiku/.test(model)) {
      return null;
    }
    if (model.includes("fable") || model.includes("mythos")) {
      if (/(?:fable|mythos)-5(?:-|\.)1(?:$|-|\[|@)/.test(model)) {
        return "claude-fable-5-1";
      }
      return "claude-fable";
    }
    if (model.includes("opus")) {
      if (/(?:opus-5(?:-|\.)5)(?:$|-|\[|@)/.test(model)) {
        return "claude-opus-5-5";
      }
      if (model.includes("opus-4-1") || model.includes("opus-4.1")) {
        return "claude-opus-4.1";
      }
      if (
        model.includes("opus-4-5") ||
        model.includes("opus-4.5") ||
        model.includes("opus-4-6") ||
        model.includes("opus-4.6") ||
        model.includes("opus-4-7") ||
        model.includes("opus-4.7") ||
        model.includes("opus-4-8") ||
        model.includes("opus-4.8")
      ) {
        return "claude-opus";
      }
      if (model.includes("opus-4")) {
        return "claude-opus-4";
      }
      return "claude-opus";
    }
    if (model.includes("sonnet")) {
      if (/sonnet-5(?:-|\.)5(?:$|-|\[|@)/.test(model)) {
        return "claude-sonnet-5-5";
      }
      if (model.includes("sonnet-5")) {
        return "claude-sonnet-5";
      }
      return "claude-sonnet";
    }
    if (model.includes("haiku")) {
      // Requests above Haiku 5.5's long-prompt threshold carry the
      // long_prompt tier; see requestPriceTier.
      if (/haiku-5(?:-|\.)5(?:$|-|\[|@)/.test(model)) {
        return "claude-haiku-5-5";
      }
      if (
        model.includes("haiku-3-5") ||
        model.includes("haiku-3.5") ||
        model.includes("3-5-haiku") ||
        model.includes("3.5-haiku")
      ) {
        return "claude-haiku-3.5";
      }
      return "claude-haiku";
    }
    return null;
  }

  // These internal, subscription-only, or preview slugs have no published
  // first-party API token price. Returning no price is safer than assigning a
  // neighboring public model's rate.
  if (
    model.startsWith("codex-auto-review") ||
    model.startsWith("gpt-5.3-codex-spark") ||
    model.startsWith("gpt-5-codex-mini") ||
    model.startsWith("gpt-5.4-cyber")
  ) {
    return null;
  }

  if (model === "gpt-5.6" || model === "gpt-daybreak-blue-latest") {
    return "gpt-5.6-sol";
  }
  if (model === "gpt-daybreak-red-latest") {
    return "gpt-5.6-cyber";
  }

  if (
    model === "gpt-6-astra" ||
    model === "gpt-6-sol" ||
    model === "gpt-6.1-sol" ||
    model === "gpt-6.1-terra" ||
    model === "gpt-6-luna"
  ) {
    return model;
  }

  for (const key of [
    "gpt-5.6-cyber",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5-pro",
    "gpt-5.5",
    "gpt-5.4-nano",
    "gpt-5.4-mini",
    "gpt-5.4-pro",
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.2-pro",
    "gpt-5.2",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex",
    "gpt-5.1",
    "gpt-5-codex",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-pro",
    "gpt-5",
    "gpt-4o-2024-05-13",
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4.1-nano",
    "gpt-4.1-mini",
    "gpt-4.1",
    "o1-pro",
    "o3-pro",
    "o4-mini",
    "o3-mini",
    "o1-mini",
    "o3",
    "o1",
    "gpt-4-turbo-2024-04-09",
    "gpt-4-0125-preview",
    "gpt-4-1106-vision-preview",
    "gpt-4-1106-preview",
    "gpt-4-0613",
    "gpt-4-0314",
    "gpt-4-32k",
    "gpt-3.5-turbo-16k-0613",
    "gpt-3.5-turbo-instruct",
    "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-1106",
    "gpt-3.5-turbo-0613",
    "gpt-3.5-turbo-0301",
    "gpt-3.5-turbo",
    "codex-mini-latest",
    "davinci-002",
    "babbage-002",
  ]) {
    if (model.startsWith(key)) {
      return key;
    }
  }

  if (model.includes("gemini")) {
    // Image, TTS, live, transcribe, native-audio, and computer-use models price
    // by output unit (pixels, seconds, queries) rather than by tokens, so they
    // have no comparable text-token rate. Leaving them unpriced matches the
    // "no guessed prices" rule used for Codex's unpublished slugs.
    if (
      model.includes("image") ||
      model.includes("tts") ||
      model.includes("live") ||
      model.includes("transcribe") ||
      model.includes("native-audio") ||
      model.includes("computer-use")
    ) {
      return null;
    }
    if (model.includes("flash-lite")) {
      if (model.includes("3.5")) {
        return "gemini-3.5-flash-lite";
      }
      if (model.includes("3.1")) {
        return "gemini-3.1-flash-lite";
      }
      if (model.includes("2.5")) {
        return "gemini-2.5-flash-lite";
      }
      return null;
    }
    if (model.includes("pro")) {
      if (model.includes("3.1")) {
        return "gemini-3.1-pro";
      }
      if (model.includes("2.5")) {
        return "gemini-2.5-pro";
      }
      return null;
    }
    if (model.includes("3.8")) {
      return "gemini-3.8-flash";
    }
    if (model.includes("3.7")) {
      return "gemini-3.7-flash";
    }
    if (model.includes("3.6")) {
      return "gemini-3.6-flash";
    }
    if (model.includes("3.5")) {
      return "gemini-3.5-flash";
    }
    if (model.includes("3-flash")) {
      return "gemini-3-flash-preview";
    }
    if (model.includes("2.5")) {
      return "gemini-2.5-flash";
    }
    // The delisted 2.0 line and unrecognized versions have no published rate.
    return null;
  }

  return null;
}

export function isPriceable(model: string): boolean {
  return canonicalModel(model) !== null;
}

/** Request-level rate modifiers. `fast` is Anthropic's fast mode; `long_prompt`
 * is a model's surcharge for prompts above a published length. */
export const PRICE_TIERS = ["standard", "fast", "long_prompt"] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];

// Haiku 5.5 bills every token category at 5x once the prompt (uncached input
// plus cache reads and writes) exceeds 100,000 tokens.
const HAIKU_5_5_LONG_PROMPT_TOKENS = 100_000;
const HAIKU_5_5_LONG_PROMPT_MULTIPLIER = 5;
// Fast mode doubles every token category, cache included, on the Opus models
// that offer it. Opus 4.6 accepts the flag but bills standard rates, so it is
// left out rather than matched by the shared claude-opus tier.
const FAST_MODE_MULTIPLIER = 2;
const FAST_MODE_MODEL = /opus-(?:5(?:[-.]5)?|4[-.]8)(?:$|-|\[|@)/;

export function isPriceTier(value: string): value is PriceTier {
  return (PRICE_TIERS as readonly string[]).includes(value);
}

/** The tier one API request bills at, from its model, usage, and the `speed`
 * the provider reported for it. */
export function requestPriceTier(
  model: string | null | undefined,
  usage: TokenUsage,
  speed: string | null | undefined,
): PriceTier {
  if (model == null) {
    return "standard";
  }
  if (speed === "fast" && FAST_MODE_MODEL.test(model.toLowerCase())) {
    return "fast";
  }
  const prompt = usage.input + usage.cacheRead + usage.cacheCreation;
  if (canonicalModel(model) === "claude-haiku-5-5" && prompt > HAIKU_5_5_LONG_PROMPT_TOKENS) {
    return "long_prompt";
  }
  return "standard";
}

function tierMultiplier(tier: PriceTier): number {
  switch (tier) {
    case "standard":
      return 1;
    case "fast":
      return FAST_MODE_MULTIPLIER;
    case "long_prompt":
      return HAIKU_5_5_LONG_PROMPT_MULTIPLIER;
  }
}

export function estimateCost(
  model: string | null | undefined,
  usage: TokenUsage,
  pricing: ReadonlyMap<string, Price>,
  tier: PriceTier = "standard",
): number {
  const parts = estimateCostParts(model, usage, pricing, tier);
  return parts.input + parts.output + parts.cacheRead + parts.cacheCreation;
}

export interface CostParts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export function estimateCostParts(
  model: string | null | undefined,
  usage: TokenUsage,
  pricing: ReadonlyMap<string, Price>,
  tier: PriceTier = "standard",
): CostParts {
  if (model == null) {
    return emptyCostParts();
  }
  const key = canonicalModel(model);
  if (key == null) {
    return emptyCostParts();
  }
  const price = pricing.get(key);
  if (price == null) {
    return emptyCostParts();
  }

  const multiplier = tierMultiplier(tier);
  const per = (tokens: number, rate: number): number => (tokens * rate * multiplier) / 1_000_000.0;
  // Clamped: a source that reports a 1h figure larger than the total must not
  // produce a negative 5-minute remainder.
  const creationTotal = Math.max(0, usage.cacheCreation);
  const creation1h = Math.min(Math.max(0, usage.cacheCreation1h), creationTotal);
  const creation5m = creationTotal - creation1h;
  return {
    input: per(usage.input, price.inputPerMtok),
    output: per(usage.output, price.outputPerMtok),
    cacheRead: per(usage.cacheRead, price.cacheReadPerMtok),
    cacheCreation:
      per(creation5m, price.cacheWritePerMtok) + per(creation1h, price.cacheWrite1hPerMtok),
  };
}

function emptyCostParts(): CostParts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}
