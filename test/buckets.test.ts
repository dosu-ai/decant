import { describe, expect, test } from "bun:test";
import { bashBucket, blockBucket, toolBucket } from "../src/buckets.ts";

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
    expect(toolBucket("read")).toBe("context");
    expect(toolBucket("write")).toBe("code");
    expect(toolBucket("edit_file")).toBe("code");
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
    expect(toolBucket("shell", { command: "git status --short" })).toBe("context");
    expect(toolBucket("terminal", { cmd: "bun test" })).toBe("code");
  });

  test("classifies transcript block families", () => {
    expect(blockBucket("thinking")).toBe("planning");
    expect(blockBucket("text")).toBe("communicating");
    expect(blockBucket("tool_use", "Write")).toBe("code");
    expect(blockBucket("tool_result", "Read")).toBe("context");
  });
});
