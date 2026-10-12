import type { SessionSummary } from "./types.ts";

type CostSource = SessionSummary["cost_source"];

/** Short suffix shown beside a session's cost; null when Decant priced it. */
export function costSourceLabel(source: CostSource): string | null {
  if (source === "reported") {
    return "reported by OpenCode";
  }
  if (source === "mixed") {
    return "partly reported by OpenCode";
  }
  return null;
}

export function costSourceTooltip(source: CostSource): string {
  if (source === "reported") {
    return "Cost reported by OpenCode: Decant has no rate for this model, so the per-request cost OpenCode recorded is shown.";
  }
  if (source === "mixed") {
    return "Part of this cost was reported by OpenCode for a model Decant cannot price; the rest is estimated at Decant's list rates.";
  }
  return "Estimated at Decant's list rates from the recorded token usage.";
}
