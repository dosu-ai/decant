import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Coverage for the Stop hook that nudges toward recording durable findings.
// Each case writes a synthetic JSONL transcript, pipes the hook's stdin payload
// in, and asserts on stderr. The hook must always exit 0, so a bug in it can
// never fail a session.

const hookPath = join(import.meta.dir, "..", "scripts", "claude-hooks", "reflect-on-stop.sh");

const workDir = mkdtempSync(join(tmpdir(), "decant-reflect-hook-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

type ToolUse = { name: string; filePath?: string };

/** One assistant turn carrying the given tool_use blocks, as the transcript stores it. */
function assistantTurn(tools: ToolUse[]): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: tools.map((tool) => ({
        type: "tool_use",
        name: tool.name,
        input: tool.filePath == null ? {} : { file_path: tool.filePath },
      })),
    },
  });
}

function writeTranscript(lines: string[]): string {
  const path = join(mkdtempSync(join(workDir, "case-")), "transcript.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function runHook(payload: Record<string, unknown>): { status: number; stderr: string } {
  const result = spawnSync("bash", [hookPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

function edits(count: number, filePath = "src/cli.ts"): string[] {
  return Array.from({ length: count }, () => assistantTurn([{ name: "Edit", filePath }]));
}

describe("reflect-on-stop hook", () => {
  test("nudges when several files changed and nothing was recorded", () => {
    const transcript = writeTranscript(edits(3));
    const { status, stderr } = runHook({ transcript_path: transcript });

    expect(status).toBe(0);
    expect(stderr).toContain("3 file changes this session");
    expect(stderr).toContain("mcp__dosu__write_knowledge");
    expect(stderr).toContain("AGENTS.md");
  });

  test("stays silent for a small session", () => {
    const transcript = writeTranscript(edits(2));
    const { status, stderr } = runHook({ transcript_path: transcript });

    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  test("stays silent for a read-only session", () => {
    const transcript = writeTranscript([
      assistantTurn([{ name: "Read", filePath: "src/cli.ts" }]),
      assistantTurn([{ name: "Grep" }]),
    ]);
    const { status, stderr } = runHook({ transcript_path: transcript });

    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  test("counts a write_knowledge call as recorded", () => {
    const transcript = writeTranscript([
      ...edits(4),
      assistantTurn([{ name: "mcp__dosu__write_knowledge" }]),
    ]);
    const { status, stderr } = runHook({ transcript_path: transcript });

    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  test("counts editing AGENTS.md as recorded", () => {
    const transcript = writeTranscript([
      ...edits(3),
      assistantTurn([{ name: "Edit", filePath: "/repo/AGENTS.md" }]),
    ]);
    const { status, stderr } = runHook({ transcript_path: transcript });

    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  test("does not treat a lookalike filename as recording", () => {
    const transcript = writeTranscript([
      ...edits(3),
      assistantTurn([{ name: "Edit", filePath: "/repo/NOT_AGENTS.md" }]),
    ]);
    const { status, stderr } = runHook({ transcript_path: transcript });

    expect(status).toBe(0);
    expect(stderr).toContain("file changes this session");
  });

  test("stays silent on an empty or malformed payload", () => {
    for (const payload of ["", "not json at all", "{", "[]"]) {
      const result = spawnSync("bash", [hookPath], { input: payload, encoding: "utf8" });

      expect(result.status ?? -1).toBe(0);
      expect(result.stderr ?? "").toBe("");
    }
  });

  test("does not re-fire when the stop came from this hook", () => {
    const transcript = writeTranscript(edits(5));
    const { status, stderr } = runHook({ transcript_path: transcript, stop_hook_active: true });

    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  test("tolerates a missing transcript path", () => {
    expect(runHook({})).toEqual({ status: 0, stderr: "" });
    expect(runHook({ transcript_path: join(workDir, "does-not-exist.jsonl") })).toEqual({
      status: 0,
      stderr: "",
    });
  });

  test("tolerates malformed transcript lines", () => {
    const transcript = writeTranscript(["not json at all", ...edits(3)]);
    const { status } = runHook({ transcript_path: transcript });

    expect(status).toBe(0);
  });
});
