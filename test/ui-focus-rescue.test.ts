import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nearestUsableIndex } from "../src/ui/focus-rescue.ts";

describe("nearestUsableIndex", () => {
  test("prefers the control before the one that just disabled itself", () => {
    // Previous, Next: Next disables on the last page and focus lands on Previous.
    expect(nearestUsableIndex(1, [true, false])).toBe(0);
  });

  test("falls forward when nothing before the control is usable", () => {
    expect(nearestUsableIndex(1, [false, false, true])).toBe(2);
  });

  test("takes the nearest usable control on either side", () => {
    expect(nearestUsableIndex(3, [true, false, false, false, true])).toBe(4);
    expect(nearestUsableIndex(3, [true, false, true, false, false])).toBe(2);
  });

  test("ignores whether the disabled control itself reads as enabled", () => {
    expect(nearestUsableIndex(1, [true, true])).toBe(0);
  });

  test("returns null when the group has nothing usable left", () => {
    expect(nearestUsableIndex(0, [false])).toBeNull();
    expect(nearestUsableIndex(1, [false, false, false])).toBeNull();
  });

  test("returns null for an index outside the group", () => {
    expect(nearestUsableIndex(-1, [true, true])).toBeNull();
    expect(nearestUsableIndex(2, [true, true])).toBeNull();
  });
});

describe("disabled focus rescue wiring", () => {
  const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");
  const hook = main.slice(
    main.indexOf("function useDisabledFocusRescue("),
    main.indexOf("function PrivacyReviewLists("),
  );

  test("App installs the rescue once, not per button", () => {
    expect(main).toContain("useDisabledFocusRescue();");
    expect(main.split("useDisabledFocusRescue();")).toHaveLength(2);
  });

  test("watches disabled attributes across the whole tree", () => {
    expect(hook).toContain("new MutationObserver(");
    expect(hook).toContain('attributeFilter: ["disabled"]');
    expect(hook).toContain("subtree: true");
    expect(hook).toContain("observer.disconnect()");
  });

  test("only rescues the control that held focus, and never steals it back", () => {
    expect(hook).toContain("control !== lastFocused");
    expect(hook).toContain('control.matches(":disabled")');
    expect(hook).toContain(
      "active !== null && active !== document.body && active !== document.documentElement",
    );
  });

  test("searches widening scopes with the shared focus selector", () => {
    expect(hook).toContain("FOCUS_CANDIDATE_SELECTOR");
    expect(hook).toContain("scope = scope.parentElement");
    expect(hook).toContain("nearestUsableIndex(");
  });
});
