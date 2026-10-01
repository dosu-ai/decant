import { apportion } from "../apportion.ts";
import type { SessionSummary } from "./types.ts";

export function versionLabel(version: string | null | undefined): string {
  if (version == null || version === "") {
    return "local checkout";
  }
  return version === "dev" || version.startsWith("v") ? version : `v${version}`;
}

export function compactAxis(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${trimNumber(value / 1_000_000)}M`;
  }
  if (abs >= 1_000) {
    return `${trimNumber(value / 1_000)}K`;
  }
  return trimNumber(value);
}

export function trimNumber(value: number): string {
  return Number.isInteger(value) ? formatInt(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function field(label: string, value: string | null): string | null {
  return isPresent(value) ? `${label}: ${value}` : null;
}

export function isPresent(value: string | null | undefined): value is string {
  return value != null && value.trim() !== "";
}

export function firstLine(value: string, maxLength: number): string {
  const line = value.trim().split("\n", 1)[0] ?? "";
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}...` : line;
}

export const intFormatter = new Intl.NumberFormat();

export function formatInt(value: number): string {
  return intFormatter.format(Math.round(value));
}

export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return formatInt(value);
}

// Rounding each share on its own lets a column total 99% or 101%. Largest
// remainder keeps the visible labels summing to exactly 100.
export function roundedPercents(values: number[]): number[] {
  const weights = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return weights.map(() => 0);
  }
  return apportion(
    weights.map((value) => (value / total) * 100),
    100,
  );
}

export function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function duration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${totalSeconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function latestSessionDay(sessions: SessionSummary[]): string | null {
  const latest = sessions.find((session) => session.started_at != null)?.started_at;
  return latest == null ? null : formatDay(latest);
}

export const dayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" });

export const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function formatDay(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return dayFormatter.format(date);
}

export function durationPrecise(value: number | null): string {
  if (value == null) {
    return "—";
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  }
  return duration(value);
}

export function formatBytes(value: number | null): string {
  if (value == null) {
    return "—";
  }
  if (value < 1024) {
    return `${formatInt(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function matchText(value: string, pattern: RegExp): string | null {
  return value.match(pattern)?.[1]?.trim() ?? null;
}

export function shortPath(value: string): string {
  const parts = value.split("/").filter((part) => part !== "");
  return parts.length <= 2 ? value : `.../${parts.slice(-2).join("/")}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shortDate(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return value;
  }
  return shortDateFormatter.format(new Date(time));
}

export function basename(path: string | null | undefined): string {
  if (path == null || path === "") {
    return "-";
  }
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
