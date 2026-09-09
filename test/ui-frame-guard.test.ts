import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FrameContext, isFramed } from "../src/ui/frame-guard.ts";

function fakeWindow(top?: FrameContext): FrameContext {
  const view = { self: null as unknown, top: null as unknown };
  view.self = view;
  view.top = top ?? view;
  return view;
}

describe("frame guard", () => {
  test("does not treat the top-level window as framed", () => {
    expect(isFramed(fakeWindow())).toBe(false);
  });

  test("treats a nested window as framed", () => {
    expect(isFramed(fakeWindow(fakeWindow()))).toBe(true);
  });

  test("treats an unreadable top window as framed", () => {
    const blocked: FrameContext = {
      self: {},
      get top(): unknown {
        throw new Error("cross-origin access blocked");
      },
    };
    expect(isFramed(blocked)).toBe(true);
  });

  test("the SPA entry mounts the framed notice instead of the app", () => {
    const entry = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");
    const mount = entry.slice(entry.indexOf("createRoot(root)"));
    expect(mount).toContain("isFramed(window)");
    expect(mount).toContain("<FramedNotice />");
  });
});
