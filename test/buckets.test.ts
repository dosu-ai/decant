import { describe, expect, test } from "bun:test";
import {
  bashBucket,
  blockBucket,
  countSearches,
  isCodeEditTool,
  toolBucket,
} from "../src/buckets.ts";

describe("activity bucket classifier", () => {
  test("classifies fixed tool families", () => {
    expect(toolBucket("TodoWrite")).toBe("planning");
    expect(toolBucket("update_plan")).toBe("planning");
    expect(toolBucket("Edit")).toBe("code");
    expect(toolBucket("MultiEdit")).toBe("code");
    expect(toolBucket("apply_patch")).toBe("code");
    expect(toolBucket("Read")).toBe("context");
    expect(toolBucket("Task")).toBe("context");
    expect(toolBucket("mcp__github__search_issues")).toBe("context");
    expect(toolBucket("UnknownFutureTool")).toBe("context");
  });

  test("classifies Bash by command head and git subcommand", () => {
    expect(bashBucket("rg auth src")).toBe("context");
    expect(bashBucket("/bin/cat README.md")).toBe("context");
    expect(bashBucket("git status --short")).toBe("context");
    expect(bashBucket("git diff")).toBe("context");
    expect(bashBucket("git commit -m test")).toBe("code");
    expect(bashBucket("bun test")).toBe("code");
  });

  test("extracts Bash command from JSON input", () => {
    expect(toolBucket("Bash", { command: "ls -la" })).toBe("context");
    expect(toolBucket("Bash", '{"command":"npm install"}')).toBe("code");
    expect(toolBucket("exec_command", JSON.stringify({ cmd: "cat docs/new.md" }))).toBe("context");
    expect(toolBucket("shell", JSON.stringify({ cmd: "bun test" }))).toBe("code");
    expect(toolBucket("functions.shell", JSON.stringify({ cmd: "git diff" }))).toBe("context");
    expect(toolBucket("local_shell", JSON.stringify(JSON.stringify({ cmd: "bun test" })))).toBe(
      "code",
    );
  });

  test("classifies transcript block families", () => {
    expect(blockBucket("thinking")).toBe("planning");
    expect(blockBucket("text")).toBe("communicating");
    expect(blockBucket("tool_use", "Write")).toBe("code");
    expect(blockBucket("tool_result", "Read")).toBe("context");
  });

  test("isCodeEditTool: structured edit tools", () => {
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]) {
      expect(isCodeEditTool(t)).toBe(true);
    }
    expect(isCodeEditTool("Read")).toBe(false);
    expect(isCodeEditTool("Bash")).toBe(false); // no command -> not an edit
  });

  test("isCodeEditTool: shell commands that mutate a file count as edits", () => {
    const edits = [
      "git apply /tmp/pr.diff",
      "sed -i 's/a/b/' src/x.ts",
      "patch -p1 < /tmp/x.patch",
      'node -e \'require("fs").writeFileSync("a.ts", body)\'',
      "python3 -c \"open('a.py','w').write(x)\"",
    ];
    for (const cmd of edits) {
      expect(isCodeEditTool("Bash", { command: cmd })).toBe(true);
      expect(isCodeEditTool("shell", JSON.stringify({ command: cmd }))).toBe(true);
    }
  });

  test("isCodeEditTool: read-only / benign shell is NOT an edit", () => {
    const benign = [
      "git apply --check /tmp/pr.diff",
      "grep -rn foo src",
      "cat package.json",
      "echo hi > /dev/null",
      "yarn build > /tmp/build.log",
      "git diff --stat",
    ];
    for (const cmd of benign) {
      expect(isCodeEditTool("Bash", { command: cmd })).toBe(false);
    }
  });

  describe("search counting", () => {
    test("countSearches: structured search tools count once", () => {
      expect(countSearches("Grep", null)).toBe(1);
      expect(countSearches("Glob", null)).toBe(1);
      expect(countSearches("Read", null)).toBe(0);
    });

    test("countSearches: shell command heads count as searches", () => {
      expect(countSearches("Bash", '{"command":"rg auth src"}')).toBe(1);
      expect(countSearches("Bash", '{"command":"/usr/bin/grep -rn foo"}')).toBe(1);
      expect(countSearches("exec_command", '"{\\"cmd\\":\\"rg TODO\\"}"')).toBe(1);
      expect(countSearches("Bash", '{"command":"cat README.md"}')).toBe(0);
      expect(countSearches("Bash", '{"command":"git grep -n foo"}')).toBe(1);
    });

    test("countSearches: compound statements count each search", () => {
      expect(countSearches("Bash", '{"command":"grep -n a src; echo ---; grep -n b src"}')).toBe(2);
      expect(countSearches("Bash", '{"command":"cd src && rg handler"}')).toBe(1);
    });

    test("countSearches: pipeline filters do not count", () => {
      expect(countSearches("Bash", '{"command":"ps aux | grep node"}')).toBe(0);
      expect(countSearches("Bash", '{"command":"rg foo src | head -20"}')).toBe(1);
    });

    test("countSearches: MCP tools named like shells do not count", () => {
      // "exec" has no dot, so localToolName would leave it unchanged anyway --
      // this line returns 0 with or without the mcp__ guard. The dotted case
      // below is the one that actually exercises the guard: localToolName
      // would flatten it to "shell" (a SHELL_TOOLS name) if the mcp__ check
      // didn't short-circuit first. Don't drop the dotted case as redundant.
      expect(countSearches("mcp__posthog__exec", '{"command":"rg foo"}')).toBe(0);
      expect(countSearches("mcp__codex_apps__x.shell", '{"command":"rg foo"}')).toBe(0);
    });
  });
});

describe("Gemini CLI tool names", () => {
  test("classify shell, edit, and plan tools like their Claude and Codex peers", () => {
    expect(toolBucket("run_shell_command", { command: "cargo test --workspace" })).toBe("code");
    expect(toolBucket("run_shell_command", '{"command":"ls src","description":"List"}')).toBe(
      "context",
    );
    expect(toolBucket("write_file")).toBe("code");
    expect(toolBucket("replace")).toBe("code");
    expect(toolBucket("write_todos")).toBe("planning");
    expect(toolBucket("read_file")).toBe("context");
    expect(isCodeEditTool("replace")).toBe(true);
    expect(isCodeEditTool("run_shell_command", { command: "sed -i '' s/a/b/ src/x.ts" })).toBe(
      true,
    );
  });
});
