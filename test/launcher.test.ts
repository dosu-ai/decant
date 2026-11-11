import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canLaunch,
  command,
  launchAgent,
  openIde,
  runCommand,
  warpLaunchUri,
} from "../src/launcher.ts";
import type { UserSettings } from "../src/settings.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-launcher-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const settings: UserSettings = {
  agent: "claude",
  terminal: "ghostty",
  ide: "cursor",
  updateCheck: false,
};

describe("launcher", () => {
  test("canLaunch is macOS only and fallback commands are quoted", () => {
    expect(canLaunch("darwin")).toBe(true);
    expect(canLaunch("linux")).toBe(false);
    expect(command("claude", "fix 'this'")).toBe("claude 'fix '\\''this'\\'''");
    expect(command("unknown", "x")).toBeNull();
  });

  test("runCommand reports a spawn failure without the exception text", async () => {
    const missing = join(workDir, "no-such-launcher-binary");
    const result = await runCommand(missing, []);
    expect(result).toEqual({ ok: false, error: `Could not start ${missing}.` });
  });

  test("launchAgent returns a copyable command off macOS", async () => {
    const result = await launchAgent("codex", "make it so", "catalog:skills", settings, {
      platform: "linux",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("macOS");
    expect(result.command).toContain("codex");
    expect(result.command).toContain("decant recommendations mark catalog:skills");
  });

  test("launchAgent refuses keys that could inject prompt text", async () => {
    const calls: string[] = [];
    const result = await launchAgent("claude", "go", "x\nrm -rf ~", settings, {
      platform: "darwin",
      run: (bin) => {
        calls.push(bin);
        return { ok: true };
      },
    });
    expect(result).toEqual({ ok: false, error: "Invalid recommendation key." });
    expect(calls).toEqual([]);
  });

  test("launchAgent builds whitelisted terminal invocations on macOS", async () => {
    const calls: { bin: string; args: string[] }[] = [];
    const result = await launchAgent("claude", "ship it", null, settings, {
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

    expect(result).toEqual({ ok: true, dir: "/tmp/skills" });
    expect(calls[0]?.bin).toBe("open");
    expect(calls[0]?.args).toContain("Ghostty");
    expect(calls[0]?.args.join(" ")).toContain("claude");
  });

  describe("launch directory", () => {
    const home = join(workDir, "home");
    const project = join(workDir, "repo with 'quote");
    const saved = { home: process.env.HOME, skills: process.env.DECANT_SKILLS_DIR };
    beforeAll(() => {
      mkdirSync(home);
      mkdirSync(project);
      process.env.HOME = home;
      delete process.env.DECANT_SKILLS_DIR;
    });
    afterAll(() => {
      process.env.HOME = saved.home;
      if (saved.skills != null) {
        process.env.DECANT_SKILLS_DIR = saved.skills;
      }
    });

    /** Launch through the `run` seam and return the shell command and prompt. */
    async function launch(options: Parameters<typeof launchAgent>[4]) {
      const calls: string[][] = [];
      const result = await launchAgent("claude", "tidy the parser", "catalog:skills", settings, {
        platform: "darwin",
        run: (_bin, args) => {
          calls.push(args);
          return { ok: true };
        },
        ...options,
      });
      const shellCommand = calls[0]?.at(-1) ?? "";
      const promptPath = shellCommand.match(/cat '([^']+)'/)?.[1];
      const prompt = promptPath == null ? "" : readFileSync(promptPath, "utf8");
      if (promptPath != null) {
        rmSync(dirname(promptPath), { recursive: true, force: true });
      }
      return { result, shellCommand, prompt };
    }

    test("a row's project directory is where the agent starts", async () => {
      const { result, shellCommand, prompt } = await launch({ dir: project });
      expect(result).toEqual({ ok: true, dir: project });
      expect(shellCommand).toStartWith(`cd '${project.replace("'", "'\\''")}' && claude `);
      expect(prompt).toBe(
        "tidy the parser\n\nWhen you have completed and verified this, run: decant recommendations mark catalog:skills",
      );
    });

    test("a missing project directory falls back to home and the prompt says so", async () => {
      const missing = join(workDir, "deleted-worktree");
      const { result, shellCommand, prompt } = await launch({ dir: missing });
      expect(result).toEqual({ ok: true, dir: home });
      expect(shellCommand).toStartWith(`cd '${home}' && claude `);
      expect(prompt).toBe(
        "tidy the parser\n\n" +
          `Decant could not find that project directory on this machine, so this session started in ${home} instead. ` +
          "Locate the repository before changing anything.\n\n" +
          "When you have completed and verified this, run: decant recommendations mark catalog:skills",
      );
    });

    test("a project path that is a file, or not absolute, is not used", async () => {
      const file = join(workDir, "not-a-directory");
      writeFileSync(file, "");
      expect((await launch({ dir: file })).result.dir).toBe(home);

      const probed: string[] = [];
      const relative = await launch({
        dir: "decant",
        isDirectory: (path) => {
          probed.push(path);
          return true;
        },
      });
      expect(relative.result.dir).toBe(home);
      // A relative path would resolve against the server's own directory.
      expect(probed).toEqual([]);
    });

    test("a setup-wide row starts in home with the prompt untouched", async () => {
      const probed: string[] = [];
      const { result, prompt } = await launch({
        dir: null,
        isDirectory: (path) => {
          probed.push(path);
          return true;
        },
      });
      expect(result).toEqual({ ok: true, dir: home });
      expect(prompt).not.toContain("could not find");
      expect(probed).toEqual([]);
    });

    test("DECANT_SKILLS_DIR wins over the project directory without checking it", async () => {
      const probed: string[] = [];
      const { result, shellCommand, prompt } = await launch({
        dir: project,
        env: { DECANT_SKILLS_DIR: "/tmp/skills" },
        isDirectory: (path) => {
          probed.push(path);
          return true;
        },
      });
      expect(result).toEqual({ ok: true, dir: "/tmp/skills" });
      expect(shellCommand).toStartWith("cd '/tmp/skills' && claude ");
      expect(prompt).not.toContain("could not find");
      expect(probed).toEqual([]);
    });

    test("the directory is reported when nothing can be launched", async () => {
      const result = await launchAgent("codex", "make it so", null, settings, {
        platform: "linux",
        dir: project,
      });
      expect(result).toMatchObject({ ok: false, dir: project, command: "codex 'make it so'" });
    });

    test("Warp opens in the project directory", async () => {
      let config = "";
      const result = await launchAgent(
        "claude",
        "ship it",
        null,
        { ...settings, terminal: "warp" },
        {
          platform: "darwin",
          dir: project,
          run: (_bin, args) => {
            const uri = args[0] ?? "";
            if (uri.startsWith("warp://launch/")) {
              config = readFileSync(decodeURIComponent(uri.slice("warp://launch/".length)), "utf8");
            }
            return { ok: true };
          },
          warpConsumed: (path) => {
            rmSync(path, { recursive: true, force: true });
            return true;
          },
        },
      );
      const promptPath = config.match(/cat '([^']+)'/)?.[1];
      if (promptPath != null) {
        rmSync(dirname(promptPath), { recursive: true, force: true });
      }
      expect(result).toEqual({ ok: true, dir: project });
      expect(config).toContain(`cwd: ${JSON.stringify(project)}`);
    });
  });

  test("Warp uses a private launch configuration with the requested cwd and command", () => {
    const uri = warpLaunchUri("claude 'ship it'", "/tmp/skills");
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

  test("Warp removes private launch files and tries the cwd-only fallback when open fails", async () => {
    let configPath = "";
    const calls: string[] = [];
    const result = await launchAgent(
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

    expect(result).toEqual({
      ok: false,
      error: "open failed · open failed",
      dir: "/tmp/skills",
    });
    expect(calls[1]).toBe("warp://action/new_tab?path=%2Ftmp%2Fskills");
    expect(configPath).not.toBe("");
    expect(existsSync(configPath)).toBe(false);
  });

  test("Warp returns a self-contained copyable command when only its cwd fallback opens", async () => {
    let call = 0;
    const result = await launchAgent(
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

  test("Warp reports success only after the private launch config is consumed", async () => {
    let configDir = "";
    const result = await launchAgent(
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

    expect(result).toEqual({ ok: true, dir: "/tmp/skills" });
    expect(configDir).not.toBe("");
    expect(existsSync(configDir)).toBe(false);
  });

  test("openIde validates platform and directory before running open", async () => {
    expect((await openIde("/missing", settings, { platform: "linux" })).error).toContain("macOS");
    expect((await openIde("/missing", settings, { platform: "darwin" })).error).toContain("folder");

    const dir = join(workDir, "project");
    mkdirSync(dir);
    const calls: { bin: string; args: string[] }[] = [];
    const result = await openIde(dir, settings, {
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
