import { describe, expect, test } from "bun:test";
import { browserCommand, decideOpen, displayUrl, openBrowser } from "../src/browser.ts";

describe("displayUrl", () => {
  test("formats loopback host and port", () => {
    expect(displayUrl("127.0.0.1", 3000)).toBe("http://127.0.0.1:3000");
  });

  test("maps wildcard hosts to loopback for display", () => {
    expect(displayUrl("0.0.0.0", 8080)).toBe("http://127.0.0.1:8080");
    expect(displayUrl("::", 3000)).toBe("http://127.0.0.1:3000");
  });

  test("brackets bare IPv6 hosts", () => {
    expect(displayUrl("::1", 3000)).toBe("http://[::1]:3000");
  });

  test("passes named hosts through", () => {
    expect(displayUrl("archive.local", 3000)).toBe("http://archive.local:3000");
  });
});

describe("browserCommand", () => {
  test("darwin uses open", () => {
    expect(browserCommand("darwin")).toBe("open");
  });

  test("linux uses xdg-open", () => {
    expect(browserCommand("linux")).toBe("xdg-open");
  });

  test("other platforms have no opener", () => {
    expect(browserCommand("win32")).toBeNull();
  });
});

describe("decideOpen", () => {
  const base = {
    enabled: true,
    env: {},
    isTTY: true,
    platform: "darwin" as NodeJS.Platform,
  };

  test("opens with the platform command on an interactive terminal", () => {
    expect(decideOpen(base)).toEqual({
      open: true,
      command: "open",
      reason: "platform default",
    });
  });

  test("--no-open wins over everything", () => {
    const decision = decideOpen({ ...base, enabled: false, env: { BROWSER: "firefox" } });
    expect(decision.open).toBe(false);
  });

  test("DECANT_NO_OPEN wins over BROWSER, even set to empty", () => {
    expect(decideOpen({ ...base, env: { DECANT_NO_OPEN: "", BROWSER: "firefox" } }).open).toBe(
      false,
    );
  });

  test("BROWSER=none disables", () => {
    expect(decideOpen({ ...base, env: { BROWSER: "none" } }).open).toBe(false);
  });

  test("an explicit BROWSER bypasses the TTY and CI gates", () => {
    const decision = decideOpen({
      ...base,
      isTTY: false,
      env: { BROWSER: "firefox", CI: "1" },
    });
    expect(decision).toEqual({ open: true, command: "firefox", reason: "BROWSER" });
  });

  test("CI blocks the platform default", () => {
    expect(decideOpen({ ...base, env: { CI: "true" } }).open).toBe(false);
  });

  test("a non-TTY stdout blocks the platform default", () => {
    expect(decideOpen({ ...base, isTTY: false }).open).toBe(false);
  });

  test("platforms without an opener never open", () => {
    expect(decideOpen({ ...base, platform: "win32" }).open).toBe(false);
  });
});

describe("openBrowser", () => {
  test("spawns the command detached with the url as the only argument", () => {
    const calls: Array<{ bin: string; args: string[]; options: unknown }> = [];
    const child = { on: () => child, unref: () => {} };
    openBrowser("http://127.0.0.1:3000", "open", (bin, args, options) => {
      calls.push({ bin, args, options });
      return child;
    });
    expect(calls).toEqual([
      {
        bin: "open",
        args: ["http://127.0.0.1:3000"],
        options: { stdio: "ignore", detached: true },
      },
    ]);
  });

  test("a throwing spawner is swallowed — the printed link is the fallback", () => {
    expect(() =>
      openBrowser("http://127.0.0.1:3000", "xdg-open", () => {
        throw new Error("ENOENT");
      }),
    ).not.toThrow();
  });
});
