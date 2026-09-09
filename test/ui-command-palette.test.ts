import { describe, expect, test } from "bun:test";
import {
  buildCommandPaletteGroups,
  type CommandPaletteItem,
  flattenCommandPaletteItems,
  normalizeRecentSearches,
  paletteShortcutLabel,
  pointerMovementChangesSelection,
  reconcileCommandPaletteActiveIndex,
  reduceCommandPaletteKey,
  shouldOpenCommandPalette,
} from "../src/ui/command-palette.ts";

const item = (id: string): CommandPaletteItem => ({ id, label: id });

describe("command palette rendered order", () => {
  test("uses fixed group order and shows recent searches only for a blank query", () => {
    const groups = buildCommandPaletteGroups({
      query: "   ",
      recent: [item("recent-a")],
      sessions: [item("session-a"), item("session-b")],
      pages: [item("page-a")],
      actions: [item("action-a")],
      contentSearch: item("search-all"),
    });

    expect(groups.map((group) => group.id)).toEqual([
      "recent",
      "sessions",
      "pages",
      "actions",
      "content-search",
    ]);
    expect(flattenCommandPaletteItems(groups).map((entry) => entry.id)).toEqual([
      "recent-a",
      "session-a",
      "session-b",
      "page-a",
      "action-a",
      "search-all",
    ]);

    expect(
      buildCommandPaletteGroups({
        query: "schema",
        recent: [item("recent-a")],
        sessions: [item("session-a")],
        pages: [],
        actions: [item("action-a")],
        contentSearch: item("search-schema"),
      }).map((group) => group.id),
    ).toEqual(["sessions", "actions", "content-search"]);
  });

  test("omits empty groups while preserving caller item order", () => {
    const groups = buildCommandPaletteGroups({
      query: "",
      recent: [],
      sessions: [item("session-newest"), item("session-older")],
      pages: [],
      actions: [],
      contentSearch: null,
    });

    expect(groups).toEqual([
      {
        id: "sessions",
        label: "Sessions",
        items: [item("session-newest"), item("session-older")],
      },
    ]);
  });
});

describe("command palette key reducer", () => {
  test("walks the flattened cross-group order and wraps at both ends", () => {
    expect(
      reduceCommandPaletteKey({ activeIndex: null }, { key: "ArrowDown", itemCount: 5 }),
    ).toEqual({ activeIndex: 0, effect: "none", handled: true });
    expect(reduceCommandPaletteKey({ activeIndex: 1 }, { key: "ArrowDown", itemCount: 5 })).toEqual(
      { activeIndex: 2, effect: "none", handled: true },
    );
    expect(reduceCommandPaletteKey({ activeIndex: 4 }, { key: "ArrowDown", itemCount: 5 })).toEqual(
      { activeIndex: 0, effect: "none", handled: true },
    );
    expect(reduceCommandPaletteKey({ activeIndex: 0 }, { key: "ArrowUp", itemCount: 5 })).toEqual({
      activeIndex: 4,
      effect: "none",
      handled: true,
    });
  });

  test("supports Home, End, Enter, and Escape semantics", () => {
    expect(reduceCommandPaletteKey({ activeIndex: 3 }, { key: "Home", itemCount: 5 })).toEqual({
      activeIndex: 0,
      effect: "none",
      handled: true,
    });
    expect(reduceCommandPaletteKey({ activeIndex: 1 }, { key: "End", itemCount: 5 })).toEqual({
      activeIndex: 4,
      effect: "none",
      handled: true,
    });
    expect(reduceCommandPaletteKey({ activeIndex: 2 }, { key: "Enter", itemCount: 5 })).toEqual({
      activeIndex: 2,
      effect: "activate",
      handled: true,
    });
    expect(reduceCommandPaletteKey({ activeIndex: 2 }, { key: "Escape", itemCount: 5 })).toEqual({
      activeIndex: 2,
      effect: "close",
      handled: true,
    });
  });

  test("does not claim unrelated, empty, stale, or composing key events", () => {
    expect(reduceCommandPaletteKey({ activeIndex: null }, { key: "Enter", itemCount: 0 })).toEqual({
      activeIndex: null,
      effect: "none",
      handled: false,
    });
    expect(reduceCommandPaletteKey({ activeIndex: 8 }, { key: "Enter", itemCount: 2 })).toEqual({
      activeIndex: null,
      effect: "none",
      handled: false,
    });
    expect(reduceCommandPaletteKey({ activeIndex: 1 }, { key: "Tab", itemCount: 2 })).toEqual({
      activeIndex: 1,
      effect: "none",
      handled: false,
    });
    expect(
      reduceCommandPaletteKey(
        { activeIndex: 1 },
        { key: "ArrowDown", itemCount: 2, isComposing: true },
      ),
    ).toEqual({
      activeIndex: 1,
      effect: "none",
      handled: false,
    });
  });
});

describe("command palette selection reconciliation", () => {
  test("preserves the selected action when asynchronously loaded sessions prepend matches", () => {
    expect(
      reconcileCommandPaletteActiveIndex("content-search", [
        item("session:1"),
        item("session:2"),
        item("content-search"),
      ]),
    ).toBe(2);
  });

  test("falls back to the first item only when the prior selection disappeared", () => {
    expect(reconcileCommandPaletteActiveIndex("session:1", [item("session:2")])).toBe(0);
    expect(reconcileCommandPaletteActiveIndex(null, [])).toBeNull();
  });

  test("ignores stationary pointer events caused by keyboard scrolling", () => {
    expect(pointerMovementChangesSelection({ movementX: 0, movementY: 0 })).toBe(false);
    expect(pointerMovementChangesSelection({ movementX: 1, movementY: 0 })).toBe(true);
    expect(pointerMovementChangesSelection({ movementX: 0, movementY: -1 })).toBe(true);
  });
});

describe("command palette global shortcut", () => {
  test("modifier-K wins over focused interactive targets", () => {
    for (const modifiers of [
      { metaKey: true, ctrlKey: false },
      { metaKey: false, ctrlKey: true },
    ]) {
      expect(
        shouldOpenCommandPalette({
          key: "k",
          ...modifiers,
          altKey: false,
          shiftKey: false,
          interactiveTarget: true,
          modalOpen: false,
        }),
      ).toBe(true);
    }
  });

  test("bare slash defers to interactive targets and every shortcut defers to an open modal", () => {
    expect(
      shouldOpenCommandPalette({
        key: "/",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        interactiveTarget: false,
        modalOpen: false,
      }),
    ).toBe(true);
    expect(
      shouldOpenCommandPalette({
        key: "/",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        interactiveTarget: true,
        modalOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldOpenCommandPalette({
        key: "k",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        interactiveTarget: false,
        modalOpen: true,
      }),
    ).toBe(false);
  });

  test("uses a non-deprecated user-agent hint for the primary modifier", () => {
    expect(paletteShortcutLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe("⌘K");
    expect(paletteShortcutLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Ctrl K");
  });
});

describe("command palette recent searches", () => {
  test("trims, deduplicates, bounds, and rejects malformed storage values", () => {
    expect(normalizeRecentSearches({ nope: true })).toEqual([]);
    expect(normalizeRecentSearches([" cache ", "", "cache", 4, "tools"], " new query ")).toEqual([
      "new query",
      "cache",
      "tools",
    ]);
    expect(normalizeRecentSearches(Array.from({ length: 12 }, (_, index) => `q${index}`))).toEqual(
      Array.from({ length: 8 }, (_, index) => `q${index}`),
    );
    expect(normalizeRecentSearches(["x".repeat(300)])[0]).toHaveLength(160);
  });
});
