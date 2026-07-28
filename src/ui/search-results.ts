import { SEARCH_MATCH_END, SEARCH_MATCH_START } from "../search-query.ts";

export interface SearchSessionHit {
  session_id: number;
}

/** Flatten hits in the same session-group order the search page renders. */
export function visuallyOrderedSearchHits<T extends SearchSessionHit>(hits: readonly T[]): T[] {
  const groups = new Map<number, T[]>();
  for (const hit of hits) {
    const group = groups.get(hit.session_id);
    if (group == null) {
      groups.set(hit.session_id, [hit]);
    } else {
      group.push(hit);
    }
  }
  return [...groups.values()].flat();
}

export interface SearchSnippetPart {
  key: string;
  text: string;
  match: boolean;
}

/** Split only private FTS markers. Literal [bracketed] source text stays text. */
export function searchSnippetParts(snippet: string): SearchSnippetPart[] {
  const parts: SearchSnippetPart[] = [];
  let remaining = snippet;
  let offset = 0;
  while (remaining !== "") {
    const start = remaining.indexOf(SEARCH_MATCH_START);
    if (start < 0) {
      parts.push({ key: `text-${offset}`, text: remaining, match: false });
      break;
    }
    if (start > 0) {
      parts.push({ key: `text-${offset}`, text: remaining.slice(0, start), match: false });
    }
    const close = remaining.indexOf(SEARCH_MATCH_END, start + SEARCH_MATCH_START.length);
    if (close < 0) {
      parts.push({ key: `text-${offset + start}`, text: remaining.slice(start), match: false });
      break;
    }
    parts.push({
      key: `match-${offset + start}`,
      text: remaining.slice(start + SEARCH_MATCH_START.length, close),
      match: true,
    });
    const consumed = close + SEARCH_MATCH_END.length;
    offset += consumed;
    remaining = remaining.slice(consumed);
  }
  return parts;
}
