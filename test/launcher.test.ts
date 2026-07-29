import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canLaunch, command, launchAgent, openIde, warpLaunchUri } from "../src/launcher.ts";
import type { UserSettings } from "../src/settings.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-launcher-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const settings: UserSettings = {
  agent: "claude",
  terminal: "ghostty",
  ide: "cursor",
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

  test("Warp uses a private launch configuration with the requested cwd and command", () => {
    const uri = warpLaunchUri("claude 'ship it'", { DECANT_SKILLS_DIR: "/tmp/skills" });
    expect(uri).toStartWith("warp://launch/");
    const configPath = decodeURIComponent(uri.slice("warp://launch/".length));
    expect(configPath).toStartWith(tmpdir());
    const config = Bun.file(configPath);
    expect(config.size).toBeGreaterThan(0);
    return config.text().then((body) => {
      expect(body).toContain('cwd: "/tmp/skills"');
      expect(body).toContain("claude 'ship it'");
      rmSync(dirname(configPath), { recursive: true, force: true });
    });
  });

  test("Warp removes private launch files and tries the cwd-only fallback when open fails", () => {
    let configPath = "";
    const calls: string[] = [];
    const result = launchAgent(
      "claude",
      "ship it",
      null,
      { ...settings, terminal: "warp" },
      {
        platform: "darwin",
        env: { DECANT_SKILLS_DIR: "/tmp/skills" },
        run: (_bin, args) => {
          calls.push(args[0] ?? "");
          if ((args[0] ?? "").startsWith("warp://launch/")) {
            configPath = decodeURIComponent((args[0] ?? "").slice("warp://launch/".length));
          }
          return { ok: false, error: "open failed" };
        },
      },
    );

    expect(result).toEqual({ ok: false, error: "open failed · open failed" });
    expect(calls[1]).toBe("warp://action/new_tab?path=%2Ftmp%2Fskills");
    expect(configPath).not.toBe("");
    expect(existsSync(configPath)).toBe(false);
  });

  test("Warp returns a self-contained copyable command when only its cwd fallback opens", () => {
    let call = 0;
    const result = launchAgent(
      "claude",
      "ship it",
      null,
      { ...settings, terminal: "warp" },
      {
        platform: "darwin",
        env: { DECANT_SKILLS_DIR: "/tmp/skills" },
        run: () => {
          call += 1;
          return call === 1 ? { ok: false, error: "launch config failed" } : { ok: true };
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not confirm");
    expect(result.command).toBe("claude 'ship it'");
  });

  test("Warp reports success only after the private launch config is consumed", () => {
    let configDir = "";
    const result = launchAgent(
      "claude",
      "ship it",
      null,
      { ...settings, terminal: "warp" },
      {
        platform: "darwin",
        env: { DECANT_SKILLS_DIR: "/tmp/skills" },
        run: (_bin, args) => {
          const uri = args[0] ?? "";
          if (uri.startsWith("warp://launch/")) {
            configDir = dirname(decodeURIComponent(uri.slice("warp://launch/".length)));
          }
          return { ok: true };
        },
        warpConsumed: (path) => {
          rmSync(path, { recursive: true, force: true });
          return !existsSync(path);
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(configDir).not.toBe("");
    expect(existsSync(configDir)).toBe(false);
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
