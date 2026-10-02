import { normalizeRecentSearches } from "./command-palette.ts";

export function readRecentSearches(): string[] {
  try {
    const key = "decant-recent-searches";
    const current = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return normalizeRecentSearches(current);
  } catch {
    return [];
  }
}

export function rememberSearch(query: string): string[] {
  const values = normalizeRecentSearches(readRecentSearches(), query);
  try {
    localStorage.setItem("decant-recent-searches", JSON.stringify(values));
  } catch {
    // Search still works when storage is unavailable.
  }
  return values;
}
