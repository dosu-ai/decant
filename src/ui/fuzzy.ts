import uFuzzy from "@leeoniya/ufuzzy";

export interface SessionSearchIndexRow {
  id: number;
  title: string | null;
  project: string | null;
  tool: string;
  model: string | null;
  started_at: string | null;
}

export type SessionSearchField = "title" | "project" | "tool" | "model" | "started_at";

/** UTF-16 string offsets, matching JavaScript slice() and React text children. */
export type SessionHighlightRange = readonly [start: number, end: number];

export type SessionHighlights = Partial<
  Record<SessionSearchField, readonly SessionHighlightRange[]>
>;

export interface SessionFuzzyMatch {
  id: number;
  highlights: SessionHighlights;
}

interface SearchSegment {
  field: SessionSearchField;
  start: number;
  end: number;
  originalOffsets: readonly number[];
}

interface SearchDocument {
  row: SessionSearchIndexRow;
  text: string;
  segments: readonly SearchSegment[];
}

const SEARCH_FIELDS = [
  "title",
  "project",
  "tool",
  "model",
  "started_at",
] as const satisfies readonly SessionSearchField[];

export const SESSION_FUZZY_RANK_LIMIT = 1_000;
const MIN_PERMUTATION_CANDIDATES = 32;
const PERMUTATION_CANDIDATE_FACTOR = 4;

const matcher = new uFuzzy({
  unicode: true,
  interSplit: "[^\\p{L}\\d']+",
  intraSplit: "\\p{Ll}\\p{Lu}",
  intraBound: "\\p{L}\\d|\\d\\p{L}|\\p{Ll}\\p{Lu}",
  intraChars: "[\\p{L}\\d']",
  intraContr: "'\\p{L}{1,2}\\b",
  // A command palette should survive one internal typo without turning every
  // query into a broad subsequence match.
  intraMode: 1,
  intraIns: 1,
  intraSub: 1,
  intraTrn: 1,
  intraDel: 1,
  // Preserve the endpoint's newest-first order when all match metrics tie.
  compare: () => 0,
});

/**
 * Reusable fuzzy index for the lightweight `/api/sessions/search-index` rows.
 * Each query filters the stable haystack afresh because typo-tolerant matches
 * are not monotonic as a needle grows.
 */
export class SessionSearchIndex {
  readonly size: number;
  readonly #documents: readonly SearchDocument[];
  readonly #haystack: string[];
  readonly #foldedHaystack: string[];

  constructor(rows: readonly SessionSearchIndexRow[]) {
    this.#documents = rows.map(searchDocument);
    this.#haystack = this.#documents.map((document) => document.text);
    this.#foldedHaystack = this.#haystack.map((value) => value.toLocaleLowerCase());
    this.size = this.#documents.length;
  }

  search(query: string, limit?: number): SessionFuzzyMatch[] {
    const needle = normalizeNeedle(query);
    const resultLimit = normalizeLimit(limit, this.size);
    if (needle === "") {
      return [];
    }
    if (resultLimit === 0 || this.size === 0) {
      return [];
    }

    const terms = matcher.split(needle);
    const candidateLimit = Math.min(
      SESSION_FUZZY_RANK_LIMIT,
      Math.max(MIN_PERMUTATION_CANDIDATES, resultLimit * PERMUTATION_CANDIDATE_FACTOR),
    );
    const filtered = filterTerms(this.#haystack, terms);
    if (filtered.length === 0) {
      return [];
    }
    const rankedCandidates = relevanceShortlist(
      this.#foldedHaystack,
      filtered,
      terms,
      needle,
      candidateLimit,
    );
    if (terms.length > 1) {
      return multiTermMatches(
        this.#documents,
        this.#haystack,
        rankedCandidates,
        terms,
        resultLimit,
      );
    }

    const [, info, order] = matcher.search(
      this.#haystack,
      needle,
      terms.length > 1 ? terms.length : 0,
      SESSION_FUZZY_RANK_LIMIT,
      rankedCandidates,
    );
    if (info == null || order == null) {
      return [];
    }

    const matches: SessionFuzzyMatch[] = [];
    for (const infoIndex of order) {
      const documentIndex = info.idx[infoIndex];
      const document = documentIndex == null ? null : this.#documents[documentIndex];
      if (document == null) {
        continue;
      }
      matches.push({
        id: document.row.id,
        highlights: projectHighlightRanges(document, info.ranges[infoIndex] ?? []),
      });
      if (matches.length === resultLimit) {
        break;
      }
    }
    return matches;
  }
}

/**
 * Intersect cheap single-term filters before any ranking work. The full
 * candidate set is then ordered by a linear-time relevance approximation so
 * exact, dense matches cannot disappear behind the browser-work cap.
 */
function filterTerms(haystack: string[], terms: readonly string[]): number[] {
  let candidates: number[] | null = null;
  for (const term of [...terms].sort((left, right) => right.length - left.length)) {
    candidates = matcher.filter(haystack, term, candidates ?? undefined);
    if (candidates == null || candidates.length === 0) {
      return [];
    }
  }
  return candidates ?? [];
}

function relevanceShortlist(
  foldedHaystack: readonly string[],
  candidates: readonly number[],
  terms: readonly string[],
  needle: string,
  limit: number,
): number[] {
  const foldedNeedle = needle.toLocaleLowerCase();
  const foldedTerms = terms.map((term) => term.toLocaleLowerCase());
  return candidates
    .map((index) => {
      const value = foldedHaystack[index] ?? "";
      const exactMatches = foldedTerms.map((term) => bestExactTermMatch(value, term));
      const positions = exactMatches.map(({ position }) => position);
      const exactTerms = exactMatches.reduce(
        (count, { position }) => count + Number(position >= 0),
        0,
      );
      const boundaryPoints = exactMatches.reduce(
        (total, { boundaryPoints: points }) => total + points,
        0,
      );
      const exactPositions = positions.filter((position) => position >= 0);
      const span =
        exactPositions.length === 0
          ? Number.POSITIVE_INFINITY
          : Math.max(
              ...positions.map((position, termIndex) =>
                position < 0 ? 0 : position + (foldedTerms[termIndex]?.length ?? 0),
              ),
            ) - Math.min(...exactPositions);
      return {
        index,
        exactPhrase: Number(value.includes(foldedNeedle)),
        exactTerms,
        boundaryPoints,
        span,
        length: value.length,
      };
    })
    .sort(
      (left, right) =>
        right.exactTerms - left.exactTerms ||
        right.boundaryPoints - left.boundaryPoints ||
        right.exactPhrase - left.exactPhrase ||
        left.span - right.span ||
        left.length - right.length ||
        left.index - right.index,
    )
    .slice(0, limit)
    .map(({ index }) => index);
}

function bestExactTermMatch(
  value: string,
  term: string,
): { position: number; boundaryPoints: number } {
  let bestPosition = -1;
  let bestBoundaryPoints = -1;
  let fromIndex = 0;
  while (fromIndex <= value.length) {
    const position = value.indexOf(term, fromIndex);
    if (position < 0) {
      break;
    }
    const end = position + term.length;
    const boundaryPoints =
      Number(position === 0 || !isSearchWordCharacterAt(value, position - 1)) +
      Number(end === value.length || !isSearchWordCharacterAt(value, end));
    if (boundaryPoints > bestBoundaryPoints) {
      bestPosition = position;
      bestBoundaryPoints = boundaryPoints;
    }
    fromIndex = position + Math.max(1, term.length);
  }
  return {
    position: bestPosition,
    boundaryPoints: Math.max(0, bestBoundaryPoints),
  };
}

function isSearchWordCharacterAt(value: string, index: number): boolean {
  const codeUnit = value.charCodeAt(index);
  if (
    (codeUnit >= 48 && codeUnit <= 57) ||
    (codeUnit >= 65 && codeUnit <= 90) ||
    (codeUnit >= 97 && codeUnit <= 122) ||
    codeUnit === 39
  ) {
    return true;
  }
  if (codeUnit < 128) {
    return false;
  }
  const character =
    codeUnit >= 0xdc00 && codeUnit <= 0xdfff && index > 0
      ? value.slice(index - 1, index + 1)
      : codeUnit >= 0xd800 && codeUnit <= 0xdbff
        ? value.slice(index, index + 2)
        : (value[index] ?? "");
  return /^[\p{L}\d']$/u.test(character);
}

/**
 * Permutation ranking grows factorially and has a large cold-start cost even
 * for three terms. Rank the global shortlist above, then ask uFuzzy for each
 * term's typo-aware ranges.
 */
function multiTermMatches(
  documents: readonly SearchDocument[],
  haystack: string[],
  candidates: readonly number[],
  terms: readonly string[],
  limit: number,
): SessionFuzzyMatch[] {
  const rangesByDocument = new Map<number, number[]>();
  let eligible = new Set(candidates);
  for (const term of terms) {
    const info = matcher.info([...eligible], haystack, term);
    eligible = new Set(info.idx);
    for (let index = 0; index < info.idx.length; index += 1) {
      const documentIndex = info.idx[index];
      if (documentIndex == null) {
        continue;
      }
      const ranges = rangesByDocument.get(documentIndex) ?? [];
      rangesByDocument.set(documentIndex, ranges);
      ranges.push(...(info.ranges[index] ?? []));
    }
    if (eligible.size === 0) {
      return [];
    }
  }

  return candidates
    .filter((documentIndex) => eligible.has(documentIndex))
    .slice(0, limit)
    .flatMap((documentIndex) => {
      const document = documents[documentIndex];
      if (document == null) {
        return [];
      }
      return [
        {
          id: document.row.id,
          highlights: projectHighlightRanges(
            document,
            sortedFlatRanges(rangesByDocument.get(documentIndex) ?? []),
          ),
        },
      ];
    });
}

function sortedFlatRanges(flatRanges: readonly number[]): number[] {
  const ranges: [number, number][] = [];
  for (let index = 0; index + 1 < flatRanges.length; index += 2) {
    const start = flatRanges[index];
    const end = flatRanges[index + 1];
    if (start != null && end != null) {
      ranges.push([start, end]);
    }
  }
  return ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]).flat();
}

export function createSessionSearchIndex(
  rows: readonly SessionSearchIndexRow[],
): SessionSearchIndex {
  return new SessionSearchIndex(rows);
}

function searchDocument(row: SessionSearchIndexRow): SearchDocument {
  let text = "";
  const segments: SearchSegment[] = [];
  for (const field of SEARCH_FIELDS) {
    const rawValue = row[field];
    const value = field === "started_at" && rawValue != null ? rawValue.slice(0, 10) : rawValue;
    if (value == null || value === "") {
      continue;
    }
    if (text !== "") {
      text += " ";
    }
    const normalized = normalizedField(value);
    const start = text.length;
    text += normalized.text;
    segments.push({
      field,
      start,
      end: text.length,
      originalOffsets: normalized.originalOffsets,
    });
  }
  return { row, text, segments };
}

function normalizedField(value: string): { text: string; originalOffsets: readonly number[] } {
  const text = value.normalize("NFC");
  if (text === value) {
    return {
      text,
      originalOffsets: Array.from({ length: text.length + 1 }, (_, index) => index),
    };
  }

  const originalOffsets = Array<number>(text.length + 1).fill(0);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let normalizedOffset = 0;
  for (const part of segmenter.segment(value)) {
    const normalizedPart = part.segment.normalize("NFC");
    const originalStart = part.index;
    const originalEnd = originalStart + part.segment.length;
    for (let offset = 0; offset <= normalizedPart.length; offset += 1) {
      originalOffsets[normalizedOffset + offset] =
        offset === normalizedPart.length
          ? originalEnd
          : originalStart +
            Math.min(
              part.segment.length,
              Math.floor((offset * part.segment.length) / Math.max(1, normalizedPart.length)),
            );
    }
    normalizedOffset += normalizedPart.length;
  }
  originalOffsets[text.length] = value.length;
  return { text, originalOffsets };
}

function projectHighlightRanges(
  document: SearchDocument,
  flatRanges: readonly number[],
): SessionHighlights {
  const highlights: Partial<Record<SessionSearchField, SessionHighlightRange[]>> = {};
  for (let index = 0; index + 1 < flatRanges.length; index += 2) {
    const rawStart = flatRanges[index];
    const rawEnd = flatRanges[index + 1];
    if (rawStart == null || rawEnd == null) {
      continue;
    }
    const start = Math.max(0, Math.min(document.text.length, Math.trunc(rawStart)));
    const end = Math.max(start, Math.min(document.text.length, Math.trunc(rawEnd)));
    if (start === end) {
      continue;
    }
    for (const segment of document.segments) {
      const intersectStart = Math.max(start, segment.start);
      const intersectEnd = Math.min(end, segment.end);
      if (intersectStart >= intersectEnd) {
        continue;
      }
      const ranges = highlights[segment.field] ?? [];
      highlights[segment.field] = ranges;
      const localStart = intersectStart - segment.start;
      const localEnd = intersectEnd - segment.start;
      appendMergedRange(ranges, [
        segment.originalOffsets[localStart] ?? localStart,
        segment.originalOffsets[localEnd] ?? localEnd,
      ]);
    }
  }
  return highlights;
}

function appendMergedRange(ranges: SessionHighlightRange[], range: SessionHighlightRange): void {
  const previous = ranges.at(-1);
  if (previous == null || previous[1] < range[0]) {
    ranges.push(range);
    return;
  }
  ranges[ranges.length - 1] = [previous[0], Math.max(previous[1], range[1])];
}

function normalizeNeedle(query: string): string {
  return query.normalize("NFC").trim().replaceAll(/\s+/g, " ");
}

function normalizeLimit(limit: number | undefined, size: number): number {
  if (limit == null || limit === Number.POSITIVE_INFINITY) {
    return size;
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return 0;
  }
  return Math.min(size, Math.floor(limit));
}
