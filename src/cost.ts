import type { TokenUsage } from "./model.ts";

export interface Price {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
}

function claudePrice(inputPerMtok: number, outputPerMtok: number): Price {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok: inputPerMtok * 0.1,
    cacheWritePerMtok: inputPerMtok * 1.25,
  };
}

function openAiPrice(
  inputPerMtok: number,
  cacheReadPerMtok: number | null,
  outputPerMtok: number,
): Price {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok: cacheReadPerMtok ?? inputPerMtok,
    cacheWritePerMtok: inputPerMtok,
  };
}

function cursorPrice(
  inputPerMtok: number,
  cacheReadPerMtok: number,
  outputPerMtok: number,
  cacheWritePerMtok = inputPerMtok,
): Price {
  return {
    inputPerMtok,
    outputPerMtok,
    cacheReadPerMtok,
    cacheWritePerMtok,
  };
}

export function defaultPricing(): Map<string, Price> {
  // Standard first-party API text-token rates per 1M tokens. Claude cache writes use
  // the 5-minute cache-write rate because session logs do not distinguish 1h writes.
  // Cursor entries are API-equivalent token estimates; subscription/request billing can differ.
  return new Map<string, Price>([
    ["claude-fable", claudePrice(10.0, 50.0)],
    ["claude-opus", claudePrice(5.0, 25.0)],
    ["claude-opus-4.1", claudePrice(15.0, 75.0)],
    ["claude-opus-4", claudePrice(15.0, 75.0)],
    ["claude-sonnet-5", claudePrice(2.0, 10.0)],
    ["claude-sonnet", claudePrice(3.0, 15.0)],
    ["claude-haiku", claudePrice(1.0, 5.0)],
    ["claude-haiku-3.5", claudePrice(0.8, 4.0)],
    ["gpt-5.5", openAiPrice(5.0, 0.5, 30.0)],
    ["gpt-5.5-pro", openAiPrice(30.0, null, 180.0)],
    ["gpt-5.4", openAiPrice(2.5, 0.25, 15.0)],
    ["gpt-5.4-mini", openAiPrice(0.75, 0.075, 4.5)],
    ["gpt-5.4-nano", openAiPrice(0.2, 0.02, 1.25)],
    ["gpt-5.4-pro", openAiPrice(30.0, null, 180.0)],
    ["gpt-5.2", openAiPrice(1.75, 0.175, 14.0)],
    ["gpt-5.2-pro", openAiPrice(21.0, null, 168.0)],
    ["gpt-5.1", openAiPrice(1.25, 0.125, 10.0)],
    ["gpt-5", openAiPrice(1.25, 0.125, 10.0)],
    ["gpt-5-mini", openAiPrice(0.25, 0.025, 2.0)],
    ["gpt-5-nano", openAiPrice(0.05, 0.005, 0.4)],
    ["gpt-5-pro", openAiPrice(15.0, null, 120.0)],
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
    ["gpt-3.5-0301", openAiPrice(1.5, null, 2.0)],
    ["gpt-3.5-turbo-instruct", openAiPrice(1.5, null, 2.0)],
    ["gpt-3.5-turbo-16k-0613", openAiPrice(3.0, null, 4.0)],
    ["davinci-002", openAiPrice(2.0, null, 2.0)],
    ["babbage-002", openAiPrice(0.4, null, 0.4)],
    ["cursor-auto", cursorPrice(1.25, 0.25, 6.0)],
    ["cursor-composer-1", cursorPrice(1.25, 0.125, 10.0)],
    ["cursor-composer-1.5", cursorPrice(3.5, 0.35, 17.5)],
    ["cursor-composer-2", cursorPrice(0.5, 0.2, 2.5)],
    ["cursor-composer-2.5", cursorPrice(0.5, 0.2, 2.5)],
    // Cursor publishes fast input/output rates but not a cache-read discount.
    ["cursor-composer-2-fast", cursorPrice(1.5, 1.5, 7.5)],
    ["cursor-composer-2.5-fast", cursorPrice(3.0, 3.0, 15.0)],
  ]);
}

function canonicalModel(raw: string): string | null {
  const model = raw
    .toLowerCase()
    .replace(/^openai[/:]/, "")
    .replace(/^cursor[/:]/, "");
  const normalized = model.replace(/\s+/g, "-");

  if (normalized.startsWith("codex-auto-review") || normalized.startsWith("gpt-5.3-codex")) {
    return "gpt-5.2";
  }

  if (
    normalized === "auto" ||
    normalized.startsWith("auto-") ||
    normalized.endsWith("-auto") ||
    normalized.includes("-auto-") ||
    normalized.includes("auto+")
  ) {
    return "cursor-auto";
  }
  if (normalized.includes("composer")) {
    return cursorComposerModel(normalized);
  }

  if (
    normalized.includes("claude") ||
    normalized === "opus" ||
    normalized === "sonnet" ||
    normalized === "haiku" ||
    normalized === "fable"
  ) {
    if (normalized.includes("fable") || normalized.includes("mythos")) {
      return "claude-fable";
    }
    if (normalized.includes("opus")) {
      if (normalized.includes("opus-4-1") || normalized.includes("opus-4.1")) {
        return "claude-opus-4.1";
      }
      if (
        normalized.includes("opus-4-5") ||
        normalized.includes("opus-4.5") ||
        normalized.includes("opus-4-6") ||
        normalized.includes("opus-4.6") ||
        normalized.includes("opus-4-7") ||
        normalized.includes("opus-4.7") ||
        normalized.includes("opus-4-8") ||
        normalized.includes("opus-4.8")
      ) {
        return "claude-opus";
      }
      if (normalized.includes("opus-4")) {
        return "claude-opus-4";
      }
      return "claude-opus";
    }
    if (normalized.includes("sonnet")) {
      if (normalized.includes("sonnet-5")) {
        return "claude-sonnet-5";
      }
      return "claude-sonnet";
    }
    if (normalized.includes("haiku")) {
      if (normalized.includes("haiku-3-5") || normalized.includes("haiku-3.5")) {
        return "claude-haiku-3.5";
      }
      return "claude-haiku";
    }
    return null;
  }

  for (const key of [
    "gpt-5.5-pro",
    "gpt-5.5",
    "gpt-5.4-nano",
    "gpt-5.4-mini",
    "gpt-5.4-pro",
    "gpt-5.4",
    "gpt-5.2-pro",
    "gpt-5.2",
    "gpt-5.1",
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
    "gpt-3.5-0301",
    "gpt-3.5-turbo",
    "davinci-002",
    "babbage-002",
  ]) {
    if (normalized.startsWith(key)) {
      return key;
    }
  }

  return null;
}

function cursorComposerModel(normalized: string): string | null {
  const version = normalized.match(/(?:^|[-_/])composer[-_/]?(1(?:[.-]5)?|2(?:[.-]5)?)/)?.[1];
  if (version == null) {
    return null;
  }
  const canonicalVersion = version.replace("-", ".");
  const fast = /(?:^|[-_/])fast(?:$|[-_/])/.test(normalized);
  if (canonicalVersion === "2.5") {
    return fast ? "cursor-composer-2.5-fast" : "cursor-composer-2.5";
  }
  if (canonicalVersion === "2") {
    return fast ? "cursor-composer-2-fast" : "cursor-composer-2";
  }
  if (canonicalVersion === "1.5") {
    return "cursor-composer-1.5";
  }
  return canonicalVersion === "1" ? "cursor-composer-1" : null;
}

export function isPriceable(model: string): boolean {
  return canonicalModel(model) !== null;
}

export function estimateCost(
  model: string | null | undefined,
  usage: TokenUsage,
  pricing: ReadonlyMap<string, Price>,
): number {
  const parts = estimateCostParts(model, usage, pricing);
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

  const per = (tokens: number, rate: number): number => (tokens * rate) / 1_000_000.0;
  return {
    input: per(usage.input, price.inputPerMtok),
    output: per(usage.output, price.outputPerMtok),
    cacheRead: per(usage.cacheRead, price.cacheReadPerMtok),
    cacheCreation: per(usage.cacheCreation, price.cacheWritePerMtok),
  };
}

function emptyCostParts(): CostParts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}
