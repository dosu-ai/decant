import { USAGE_LIST_MAX_LIMIT } from "../api-limits.ts";

export function integerParam(url: URL, name: string, fallback: number, allowZero = false): number {
  const raw = url.searchParams.get(name);
  if (raw == null) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && (parsed > 0 || (allowZero && parsed === 0)) ? parsed : fallback;
}

export function usageLimit(url: URL, fallback: number): number {
  return Math.min(integerParam(url, "limit", fallback), USAGE_LIST_MAX_LIMIT);
}

export function isValidSessionId(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0;
}

export function isNonNegativeInteger(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0;
}
