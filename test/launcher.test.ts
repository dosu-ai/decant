import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canLaunch, command, launchAgent, openIde } from "../src/launcher.ts";
import type { UserSettings } from "../src/settings.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-launcher-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const settings: UserSettings = {
  agent: "claude",
  terminal: "ghostty",
  ide: "cursor",
  dosuSuggestions: "show",
};

describe("launcher", () => {
  test("canLaunch is macOS only and fallback commands are quoted", () => {
    expect(canLaunch("darwin")).toBe(true);
    expect(canLaunch("linux")).toBe(false);
    expect(command("claude", "fix 'this'")).toBe("claude 'fix '\\''this'\\'''");
    expect(command("unknown", "x")).toBeNull();
  });

  test("launchAgent returns a copyable command off macOS", () => {
    const result = launchAgent("codex", "make it so", "catalog:skills", settings, {
      platform: "linux",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("macOS");
    expect(result.command).toContain("codex");
    expect(result.command).toContain("decant recommendations mark catalog:skills");
  });

  test("launchAgent builds whitelisted terminal invocations on macOS", () => {
    const calls: { bin: string; args: string[] }[] = [];
    const result = launchAgent("claude", "ship it", null, settings, {
      platform: "darwin",
      env: { DECANT_SKILLS_DIR: "/tmp/skills", SHELL: "/bin/zsh" },
      tempName: () => "decant-launcher-test-prompt.txt",
      run: (bin, args) => {
        calls.push({ bin, args });
        return { ok: true };
      },
    });
    // The prompt now lives in a fresh mkdtemp dir embedded in the recorded
    // command; recover it from there to clean up.
    const promptPath = calls[0]?.args.join(" ").match(/cat '([^']+)'/)?.[1];
    if (promptPath != null) {
      rmSync(dirname(promptPath), { recursive: true, force: true });
    }

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.bin).toBe("open");
    expect(calls[0]?.args).toContain("Ghostty");
    expect(calls[0]?.args.join(" ")).toContain("claude");
  });

  test("openIde validates platform and directory before running open", () => {
    expect(openIde("/missing", settings, { platform: "linux" }).error).toContain("macOS");
    expect(openIde("/missing", settings, { platform: "darwin" }).error).toContain("folder");

    const dir = join(workDir, "project");
    mkdirSync(dir);
    const calls: { bin: string; args: string[] }[] = [];
    const result = openIde(dir, settings, {
      platform: "darwin",
      run: (bin, args) => {
        calls.push({ bin, args });
        return { ok: true };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ bin: "open", args: ["-a", "Cursor", dir] }]);
  });
});
