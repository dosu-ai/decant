import type { ReactNode } from "react";
import { effortDisplayLabel, effortTooltip } from "./effort.ts";
import { capitalize, formatInt } from "./format.ts";
import { BrandMark } from "./icons.tsx";
import { stripMarkupTags } from "./session-title.ts";
import type { BadgeTone, BrandIconName } from "./types.ts";

export function Badge({
  children,
  className,
  mono = false,
  title,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  mono?: boolean;
  title?: string;
  tone?: BadgeTone;
}) {
  return (
    <span
      className={`badge tone-${tone}${mono ? " is-mono" : ""}${className ? ` ${className}` : ""}`}
      title={title}
    >
      {children}
    </span>
  );
}

export function ToolBadge({ tool }: { tool: string | null | undefined }) {
  if (tool === "claude_code") {
    return (
      <Badge tone="claude">
        <BrandMark name="claude" />
        Claude
      </Badge>
    );
  }
  if (tool === "codex") {
    return (
      <Badge tone="openai">
        <BrandMark name="openai" />
        Codex
      </Badge>
    );
  }
  if (tool === "gemini") {
    return (
      <Badge tone="gemini">
        <BrandMark name="gemini" />
        Gemini
      </Badge>
    );
  }
  return <Badge>{tool ?? "-"}</Badge>;
}

export function ModelBadge({ model }: { model: string | null | undefined }) {
  const label = displayModelLabel(model);
  if (label == null) {
    return <span className="faint">-</span>;
  }
  const tone = brandTone(label);
  const theme = modelTheme(label);
  const icon = theme == null ? modelBrandIcon(label, tone) : null;
  return (
    <Badge
      mono
      title={model?.trim() ?? label}
      tone={tone}
      className={theme == null ? undefined : `model-${theme}`}
    >
      {icon == null ? null : <BrandMark name={icon} />}
      <span className="model-label">{label}</span>
    </Badge>
  );
}

export type ModelTheme = "astra" | "sol" | "luna";

export function modelTheme(model: string): ModelTheme | null {
  const tier = /(?:^|[/:])gpt-(?:5\.6|6(?:\.1)?)-(astra|sol|luna)$/i.exec(model)?.[1];
  return tier == null ? null : (tier.toLowerCase() as ModelTheme);
}

export function EffortBadge({
  effort,
  labeled = false,
  levels = [],
}: {
  effort: string | null | undefined;
  labeled?: boolean;
  levels?: string[];
}) {
  const label = effort?.trim().toLowerCase();
  const displayLabel = effortDisplayLabel(effort, labeled);
  if (label == null || label === "") {
    return (
      <span className="faint" title={effortTooltip(effort, levels)}>
        {displayLabel}
      </span>
    );
  }
  return (
    <Badge
      mono
      title={effortTooltip(effort, levels) ?? effortDisplayLabel(effort)}
      tone={label === "mixed" ? "warning" : "info"}
    >
      {displayLabel}
    </Badge>
  );
}

export function ThinkingBadge({ tokens, source }: { tokens: number; source: string | null }) {
  const observed =
    source === "inferred"
      ? `Reasoning estimated from output: ~${formatInt(tokens)} tokens`
      : `Extended thinking observed: ${formatInt(tokens)} reported reasoning tokens`;
  return (
    <Badge
      mono
      title={`${observed}. This source does not record a discrete effort level.`}
      tone="info"
    >
      thinking on
    </Badge>
  );
}

/** The Effort cell shows the recorded level when the source logs one. When
 * the source logs reasoning tokens but no level, as Gemini does, it shows the
 * derived thinking state instead of an empty dash. */
export function ReasoningBadge({
  effort,
  levels,
  totalReasoningTokens,
  reasoningSource,
  labeled = false,
}: {
  effort: string | null | undefined;
  levels: string[];
  totalReasoningTokens: number;
  reasoningSource: string | null;
  labeled?: boolean;
}) {
  if ((effort ?? "").trim() === "" && totalReasoningTokens > 0) {
    return <ThinkingBadge tokens={totalReasoningTokens} source={reasoningSource} />;
  }
  return <EffortBadge effort={effort} labeled={labeled} levels={levels} />;
}

export function displayModelLabel(model: string | null | undefined): string | null {
  if (model == null) {
    return null;
  }
  const trimmed = model.trim();
  if (trimmed === "") {
    return null;
  }
  const tagOnly = trimmed.match(/^<([a-z][a-z0-9_-]*)>$/i);
  if (tagOnly != null) {
    return capitalize((tagOnly[1] ?? "").replace(/[-_]+/g, " "));
  }
  const stripped = stripMarkupTags(trimmed);
  return stripped === "" ? null : stripped;
}

export function modelBrandIcon(model: string, tone: BadgeTone): BrandIconName | null {
  if (tone === "openai") {
    return "openai";
  }
  if (tone === "claude") {
    return model.toLowerCase().includes("anthropic") && !model.toLowerCase().includes("claude")
      ? "anthropic"
      : "claude";
  }
  if (tone === "gemini") {
    return "gemini";
  }
  return null;
}

export function brandTone(model: string | null | undefined): BadgeTone {
  const normalized = (model ?? "").toLowerCase();
  if (
    normalized.includes("claude") ||
    normalized.includes("anthropic") ||
    normalized.includes("opus") ||
    normalized.includes("sonnet") ||
    normalized.includes("haiku")
  ) {
    return "claude";
  }
  if (
    normalized.includes("gpt") ||
    normalized.includes("openai") ||
    normalized.includes("codex") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3")
  ) {
    return "openai";
  }
  if (normalized.includes("gemini") || normalized.includes("gemma")) {
    return "gemini";
  }
  return "neutral";
}

export function toneName(tone: string | null | undefined): BadgeTone {
  return tone === "success" ||
    tone === "warning" ||
    tone === "danger" ||
    tone === "info" ||
    tone === "accent"
    ? tone
    : "neutral";
}

export function providerIdentity(tool: string): {
  key: "assistant" | "claude" | "openai" | "gemini";
  label: string;
  tone: BadgeTone;
  icon: BrandIconName | null;
} {
  if (tool === "claude_code") {
    return { key: "claude", label: "Claude", tone: "claude", icon: "claude" };
  }
  if (tool === "codex") {
    return { key: "openai", label: "Codex", tone: "openai", icon: "openai" };
  }
  if (tool === "gemini") {
    return { key: "gemini", label: "Gemini", tone: "gemini", icon: "gemini" };
  }
  return { key: "assistant", label: "Assistant", tone: "accent", icon: null };
}
