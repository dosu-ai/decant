import { describe, expect, test } from "bun:test";
import { flattenSessionRows, virtualTablePadding } from "../src/ui/session-rows.ts";

type Node = { id: number; subagents?: Node[] };

const tree: Node[] = [
  {
    id: 1,
    subagents: [{ id: 11, subagents: [{ id: 111 }] }, { id: 12 }],
  },
  { id: 2 },
  { id: 3, subagents: [{ id: 31 }] },
];

describe("flattenSessionRows", () => {
  test("collapsed sessions render only top-level rows", () => {
    const rows = flattenSessionRows(tree, new Set());
    expect(rows.map((row) => row.session.id)).toEqual([1, 2, 3]);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
  });

  test("expanding a session splices its subagents in depth-first order", () => {
    const rows = flattenSessionRows(tree, new Set([1]));
    expect(rows.map((row) => row.session.id)).toEqual([1, 11, 12, 2, 3]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 0, 0]);
  });

  test("nested expansion tracks depth per level", () => {
    const rows = flattenSessionRows(tree, new Set([1, 11, 3]));
    expect(rows.map((row) => row.session.id)).toEqual([1, 11, 111, 12, 2, 3, 31]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1, 0, 0, 1]);
  });

  test("expanding a collapsed child's id alone changes nothing", () => {
    const rows = flattenSessionRows(tree, new Set([11]));
    expect(rows.map((row) => row.session.id)).toEqual([1, 2, 3]);
  });

  test("empty input flattens to no rows", () => {
    expect(flattenSessionRows([], new Set([1]))).toEqual([]);
  });
});

describe("virtualTablePadding", () => {
  test("no visible items needs no spacers", () => {
    expect(virtualTablePadding({ items: [], scrollMargin: 480, totalSize: 5200 })).toEqual({
      bottom: 0,
      top: 0,
    });
  });

  test("window at the top pads only below", () => {
    const items = [
      { end: 532, start: 480 },
      { end: 584, start: 532 },
    ];
    expect(virtualTablePadding({ items, scrollMargin: 480, totalSize: 5200 })).toEqual({
      bottom: 5200 - 104,
      top: 0,
    });
  });

  test("window mid-list pads above and below", () => {
    const items = [
      { end: 2652, start: 2600 },
      { end: 2704, start: 2652 },
    ];
    expect(virtualTablePadding({ items, scrollMargin: 480, totalSize: 5200 })).toEqual({
      bottom: 5200 - (2704 - 480),
      top: 2600 - 480,
    });
  });

  test("window at the bottom pads only above", () => {
    const items = [{ end: 5680, start: 5628 }];
    expect(virtualTablePadding({ items, scrollMargin: 480, totalSize: 5200 })).toEqual({
      bottom: 0,
      top: 5628 - 480,
    });
  });

  test("rounding drift never produces negative spacers", () => {
    const items = [{ end: 5201.5, start: 5149 }];
    expect(virtualTablePadding({ items, scrollMargin: 0, totalSize: 5200 })).toEqual({
      bottom: 0,
      top: 5149,
    });
  });
});
