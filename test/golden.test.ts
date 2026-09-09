import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// These mechanically generated files pin the synthetic fixture contract: the
// goldens exist, parse, cover every fixture, and are internally consistent.
const goldenDir = join(import.meta.dir, "golden");
const keySeparator = "\0";

async function loadGolden<T>(relPath: string): Promise<T> {
  return (await Bun.file(join(goldenDir, relPath)).json()) as T;
}

function listGoldenFiles(dir = goldenDir, prefix = ""): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const relPath = prefix ? join(prefix, entry) : entry;
    if (statSync(path).isDirectory()) {
      return listGoldenFiles(path, relPath);
    }
    return [relPath];
  });
}

type SessionKey = { tool: string; source_session_id: string };
type GoldenMeta = {
  fixtures: string[];
  generator: string;
  regeneration: string;
  row_dumps: string[];
};

describe("golden harness", () => {
  test("covers every fixture transcript exactly once", async () => {
    const meta = await loadGolden<GoldenMeta>("meta.json");
    const sessions = await loadGolden<SessionKey[]>("rows/sessions.json");
    expect(sessions).toHaveLength(meta.fixtures.length);
    expect(meta.generator).toBe("synthetic TypeScript golden snapshot");
    expect(meta.regeneration).toContain("synthetic fixtures");
    const tools = new Set(sessions.map((s) => s.tool));
    expect(tools).toEqual(new Set(["claude_code", "codex", "gemini"]));
  });

  test("row dumps are internally consistent on natural keys", async () => {
    const meta = await loadGolden<GoldenMeta>("meta.json");
    const sessions = await loadGolden<SessionKey[]>("rows/sessions.json");
    const keys = new Set(sessions.map((s) => `${s.tool}${keySeparator}${s.source_session_id}`));
    expect(keys.size).toBe(sessions.length);

    const sessionKeyedDumps = new Set(["messages", "blocks", "tool_calls", "file_refs"]);
    for (const dump of meta.row_dumps) {
      const rows = await loadGolden<Record<string, unknown>[]>(`rows/${dump}.json`);
      expect(rows.length).toBeGreaterThan(0);
      if (!sessionKeyedDumps.has(dump)) {
        continue;
      }
      for (const row of rows) {
        expect(keys).toContain(`${row.tool}${keySeparator}${row.source_session_id}`);
      }
    }
  });

  test("blocks nest under messages that exist", async () => {
    const messages = await loadGolden<(SessionKey & { seq: number })[]>("rows/messages.json");
    const messageKeys = new Set(
      messages.map((m) => `${m.tool}${keySeparator}${m.source_session_id}${keySeparator}${m.seq}`),
    );
    const blocks = await loadGolden<(SessionKey & { seq: number })[]>("rows/blocks.json");
    for (const block of blocks) {
      expect(messageKeys).toContain(
        `${block.tool}${keySeparator}${block.source_session_id}${keySeparator}${block.seq}`,
      );
    }
  });

  test("goldens contain no machine-specific absolute paths", async () => {
    const relPaths = listGoldenFiles();
    const allText: string[] = [];
    for (const relPath of relPaths) {
      const text = await Bun.file(join(goldenDir, relPath)).text();
      allText.push(text);
      for (const [name, pattern] of [
        ["macOS temp path", /\/(?:private\/)?var\/folders\//],
        ["Linux home path", /\/home\/[^/\s"]+\//],
        ["non-fixture macOS user path", /\/Users\/(?!dev\/)[^/\s"]+\//],
      ] as const) {
        expect(text, `${relPath} leaked ${name}`).not.toMatch(pattern);
      }
    }
    expect(allText.join("\n")).toContain("<TMP>");
  });

  test("CLI goldens agree with the row dumps", async () => {
    const sessions = await loadGolden<SessionKey[]>("rows/sessions.json");
    const ls = await loadGolden<unknown[]>("cli/ls.json");
    expect(ls).toHaveLength(sessions.length);
  });
});
