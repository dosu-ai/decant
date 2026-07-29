import { describe, expect, test } from "bun:test";
import {
  createSessionSearchIndex,
  SESSION_FUZZY_RANK_LIMIT,
  type SessionSearchIndexRow,
} from "../src/ui/fuzzy.ts";

const sessions: SessionSearchIndexRow[] = [
  {
    id: 41,
    title: "Fix schema migration",
    project: "/workspace/decant",
    tool: "codex",
    model: "gpt-5.6",
    started_at: "2026-07-29T12:00:00Z",
  },
  {
    id: 42,
    title: "Investigate analytics regression",
    project: "/workspace/decant",
    tool: "claude_code",
    model: "claude-opus-4-1",
    started_at: "2026-07-29T11:00:00Z",
  },
  {
    id: 43,
    title: "Archive session state",
    project: "/workspace/other",
    tool: "codex",
    model: "gpt-5.6",
    started_at: "2026-07-28T18:00:00Z",
  },
];

describe("session fuzzy search", () => {
  test("returns ranked session ids and field-local highlight ranges", () => {
    const index = createSessionSearchIndex(sessions);

    expect(index.search("schema")).toEqual([
      {
        id: 41,
        highlights: {
          title: [[4, 10]],
        },
      },
    ]);
    expect(index.search("workspace other")).toEqual([
      {
        id: 43,
        highlights: {
          project: [
            [1, 10],
            [11, 16],
          ],
        },
      },
    ]);
  });

  test("tolerates one internal typo and keeps ranges safe for React text slicing", () => {
    const index = createSessionSearchIndex(sessions);
    const [match] = index.search("schma");

    expect(match).toEqual({
      id: 41,
      highlights: {
        title: [[4, 10]],
      },
    });
    for (const [field, ranges] of Object.entries(match?.highlights ?? {})) {
      const value = sessions[0]?.[field as keyof SessionSearchIndexRow];
      expect(typeof value).toBe("string");
      for (const [start, end] of ranges ?? []) {
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        expect(end).toBeLessThanOrEqual((value as string).length);
      }
    }
  });

  test("reuses an index across narrowing, replacement, blank, and limited searches", () => {
    const index = createSessionSearchIndex(sessions);

    expect(index.size).toBe(3);
    expect(index.search("decant").map((match) => match.id)).toEqual([41, 42]);
    expect(index.search("analytics decant").map((match) => match.id)).toEqual([42]);
    expect(index.search("archive").map((match) => match.id)).toEqual([43]);
    expect(index.search("   ")).toEqual([]);
    expect(index.search("codex", 1)).toHaveLength(1);
    expect(index.search("codex", 0)).toEqual([]);
    expect(
      index
        .search("codex gpt")
        .map((match) => match.id)
        .sort(),
    ).toEqual([41, 43]);
  });

  test("handles nullable fields without indexing placeholder markup", () => {
    const index = createSessionSearchIndex([
      {
        id: 99,
        title: null,
        project: null,
        tool: "codex",
        model: null,
        started_at: null,
      },
    ]);

    expect(index.search("codex")).toEqual([
      {
        id: 99,
        highlights: {
          tool: [[0, 5]],
        },
      },
    ]);
    expect(index.search("null")).toEqual([]);
  });

  test("uses endpoint order as the deterministic tiebreaker", () => {
    const tied = {
      title: "Same exact title",
      project: "/workspace/decant",
      tool: "codex",
      model: "gpt-5.6",
      started_at: "2026-07-29T12:00:00Z",
    };
    const index = createSessionSearchIndex([
      { ...tied, id: 71 },
      { ...tied, id: 72 },
    ]);

    expect(index.search("same exact").map((match) => match.id)).toEqual([71, 72]);
  });

  test("does not reuse a narrower typo candidate set for a longer non-monotonic match", () => {
    const index = createSessionSearchIndex([
      {
        id: 1,
        title: "cache",
        project: null,
        tool: "codex",
        model: null,
        started_at: null,
      },
    ]);

    expect(index.search("cah")).toEqual([]);
    expect(index.search("cahe").map((match) => match.id)).toEqual([1]);
  });

  test("bounds expensive ranking work for broad matches while keeping newest endpoint order", () => {
    const rows = Array.from(
      { length: SESSION_FUZZY_RANK_LIMIT + 200 },
      (_, index): SessionSearchIndexRow => ({
        id: index,
        title: `Codex session ${index}`,
        project: "/workspace/decant",
        tool: "codex",
        model: "gpt-5.6",
        started_at: "2026-07-29T12:00:00Z",
      }),
    );

    expect(
      createSessionSearchIndex(rows)
        .search("codex", 10)
        .map((match) => match.id),
    ).toEqual(Array.from({ length: 10 }, (_, index) => index));
  });

  test("keeps the globally strongest match when it falls beyond the work cap", () => {
    const typoRows = Array.from(
      { length: SESSION_FUZZY_RANK_LIMIT },
      (_, index): SessionSearchIndexRow => ({
        id: index,
        title: "schma",
        project: null,
        tool: "codex",
        model: null,
        started_at: null,
      }),
    );
    const exact = {
      id: SESSION_FUZZY_RANK_LIMIT,
      title: "schema",
      project: null,
      tool: "codex",
      model: null,
      started_at: null,
    } satisfies SessionSearchIndexRow;

    expect(createSessionSearchIndex([...typoRows, exact]).search("schema", 3)[0]?.id).toBe(
      exact.id,
    );
  });

  test("elevates dense phrase matches before bounding out-of-order ranking", () => {
    const noisyRows = Array.from(
      { length: 100 },
      (_, index): SessionSearchIndexRow => ({
        id: index,
        title: `alpha ${"noise ".repeat(20)}beta`,
        project: null,
        tool: "codex",
        model: null,
        started_at: null,
      }),
    );
    const dense = {
      id: 100,
      title: "alpha beta",
      project: null,
      tool: "codex",
      model: null,
      started_at: null,
    } satisfies SessionSearchIndexRow;

    expect(createSessionSearchIndex([...noisyRows, dense]).search("alpha beta", 10)[0]?.id).toBe(
      dense.id,
    );
  });

  test("preserves whole-token quality before bounding single-term ranking", () => {
    const embeddedRows = Array.from(
      { length: 100 },
      (_, index): SessionSearchIndexRow => ({
        id: index,
        title: "xschma",
        project: null,
        tool: "codex",
        model: null,
        started_at: null,
      }),
    );
    const bounded = {
      id: 100,
      title: "schma x",
      project: null,
      tool: "codex",
      model: null,
      started_at: null,
    } satisfies SessionSearchIndexRow;

    expect(createSessionSearchIndex([...embeddedRows, bounded]).search("schma", 3)[0]?.id).toBe(
      bounded.id,
    );

    const embeddedMultiTermRows = embeddedRows.map((row) => ({
      ...row,
      title: "xbeta alpha",
    }));
    expect(
      createSessionSearchIndex([
        ...embeddedMultiTermRows,
        { ...bounded, title: "beta alpha x" },
      ]).search("alpha beta", 3)[0]?.id,
    ).toBe(bounded.id);

    const letterPrefixed = embeddedRows.map((row) => ({ ...row, title: "xalpha" }));
    expect(
      createSessionSearchIndex([...letterPrefixed, { ...bounded, title: "—alpha" }]).search(
        "alpha",
        3,
      )[0]?.id,
    ).toBe(bounded.id);
  });

  test("does not drop a fuzzy multi-term match when exact candidates cross the work cap", () => {
    const unrelated = (count: number): SessionSearchIndexRow[] =>
      Array.from({ length: count }, (_, index) => ({
        id: index,
        title: `migration unrelated-${index}`,
        project: null,
        tool: "codex",
        model: null,
        started_at: null,
      }));
    const typoMatch = {
      id: 100,
      title: "migrtion schema",
      project: null,
      tool: "codex",
      model: null,
      started_at: null,
    } satisfies SessionSearchIndexRow;

    expect(
      createSessionSearchIndex([...unrelated(39), typoMatch]).search("migration schema", 10)[0]?.id,
    ).toBe(typoMatch.id);
    expect(
      createSessionSearchIndex([...unrelated(40), typoMatch]).search("migration schema", 10)[0]?.id,
    ).toBe(typoMatch.id);
  });

  test("matches multiple terms independently of field or query order", () => {
    const index = createSessionSearchIndex([
      {
        id: 1,
        title: "Archive session state",
        project: "/workspace/decant",
        tool: "codex",
        model: "gpt-5.6",
        started_at: "2026-07-29T12:00:00Z",
      },
    ]);

    expect(index.search("archive codex").map((match) => match.id)).toEqual([1]);
    expect(index.search("codex archive").map((match) => match.id)).toEqual([1]);
  });

  test("matches and highlights Unicode titles without HTML conversion", () => {
    const index = createSessionSearchIndex([
      {
        id: 1,
        title: "認証フローを修正",
        project: null,
        tool: "codex",
        model: null,
        started_at: null,
      },
      {
        id: 2,
        title: "Исправить поиск",
        project: null,
        tool: "codex",
        model: null,
        started_at: null,
      },
      {
        id: 3,
        title: "Café diagnostics",
        project: null,
        tool: "codex",
        model: null,
        started_at: null,
      },
    ]);

    expect(index.search("認証")).toEqual([{ id: 1, highlights: { title: [[0, 2]] } }]);
    expect(index.search("поиск")).toEqual([{ id: 2, highlights: { title: [[10, 15]] } }]);
    expect(index.search("Café")).toEqual([{ id: 3, highlights: { title: [[0, 4]] } }]);
  });

  test("matches canonically equivalent Unicode while preserving original UTF-16 offsets", () => {
    const index = createSessionSearchIndex([
      {
        id: 1,
        title: "Cafe\u0301 diagnostics",
        project: null,
        tool: "codex",
        model: null,
        started_at: null,
      },
      {
        id: 2,
        title: "Café diagnostics",
        project: null,
        tool: "codex",
        model: null,
        started_at: null,
      },
    ]);

    expect(index.search("Café")).toEqual([
      { id: 1, highlights: { title: [[0, 5]] } },
      { id: 2, highlights: { title: [[0, 4]] } },
    ]);
    expect(index.search("Cafe\u0301")).toEqual([
      { id: 1, highlights: { title: [[0, 5]] } },
      { id: 2, highlights: { title: [[0, 4]] } },
    ]);
  });

  test("keeps a realistic repetitive 5,000-row query within an interactive budget", () => {
    const rows = Array.from(
      { length: 5_000 },
      (_, index): SessionSearchIndexRow => ({
        id: index,
        title: `Review feature branch ${index}`,
        project: "/workspace/decant",
        tool: "codex",
        model: "gpt-5.6",
        started_at: "2026-07-29T12:00:00Z",
      }),
    );
    const index = createSessionSearchIndex(rows);
    const startedAt = performance.now();

    expect(index.search("review feature branch 499", 10).length).toBeGreaterThan(0);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test("bounds out-of-order permutations before ranking a repetitive 5,000-row corpus", () => {
    const rows = Array.from(
      { length: 5_000 },
      (_, index): SessionSearchIndexRow => ({
        id: index,
        title: `Review feature branch ${index}`,
        project: "/workspace/decant",
        tool: "codex",
        model: "gpt-5.6",
        started_at: "2026-07-29T12:00:00Z",
      }),
    );
    const index = createSessionSearchIndex(rows);
    const startedAt = performance.now();

    expect(index.search("branch review feature", 10).map((match) => match.id)).toEqual(
      Array.from({ length: 10 }, (_, rowIndex) => rowIndex),
    );
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test("avoids factorial ranking and preserves highlights for long reversed queries", () => {
    const rows = Array.from(
      { length: 5_000 },
      (_, index): SessionSearchIndexRow => ({
        id: index,
        title: `one two three four five six session ${index}`,
        project: "/workspace/decant",
        tool: "codex",
        model: "gpt-5.6",
        started_at: "2026-07-29T12:00:00Z",
      }),
    );
    const index = createSessionSearchIndex(rows);
    const startedAt = performance.now();
    const matches = index.search("six five four three two one", 10);

    expect(matches[0]).toEqual({
      id: 0,
      highlights: {
        title: [
          [0, 3],
          [4, 7],
          [8, 13],
          [14, 18],
          [19, 23],
          [24, 27],
        ],
      },
    });
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});
