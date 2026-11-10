import { expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SOURCE_FILE_BYTES, readSourceFile } from "../src/ingest-limits.ts";
import { canonicalJson, MAX_JSON_DEPTH } from "../src/json.ts";
import { MAX_ATIF_EMBEDDED_DEPTH, parseAtifDocument } from "../src/sources/atif.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCursorSession, readCursorSource } from "../src/sources/cursor.ts";
import { MAX_RECORD_BYTES, printableType } from "../src/sources/shared.ts";
import { writeCursorStore } from "./cursor-fixture.ts";

const secret = "SYNTHETIC_SECRET_TOKEN";
const valid = JSON.stringify({ type: "user", message: { role: "user", content: "hello" } });

test("deep, oversized and malformed records leave later records readable without copying text", () => {
  const content = [
    "[".repeat(30000) + '"' + secret + '"' + "]".repeat(30000),
    JSON.stringify({ type: "user", text: secret + "x".repeat(MAX_RECORD_BYTES) }),
    "{" + secret,
    JSON.stringify({ type: secret + " invalid" }),
    valid,
  ].join("\n");
  const parsed = parseClaudeSession("limits", content);
  expect(parsed.session.messages.at(-1)?.role).toBe("user");
  expect(parsed.issues.map((i) => i.error)).toEqual([
    "JSON nesting exceeds the depth limit",
    "record exceeds the byte limit",
    "record is not valid JSON",
    expect.stringContaining("(unprintable type)"),
  ]);
  expect(JSON.stringify(parsed.issues.map((i) => i.error))).not.toContain(secret);
  expect(parsed.issues.slice(0, 2).every((i) => i.rawLine === null)).toBe(true);
  expect(parsed.issues[2]?.rawLine).toBe("{" + secret);
});

test("canonical serialization rejects pathological nesting with a fixed error", () => {
  const value = JSON.parse("[".repeat(30000) + "0" + "]".repeat(30000));
  expect(() => canonicalJson(value)).toThrow("JSON nesting exceeds the depth limit");
  const allowed = "[".repeat(MAX_JSON_DEPTH) + "0" + "]".repeat(MAX_JSON_DEPTH);
  expect(canonicalJson(JSON.parse(allowed))).toBe(allowed);
});

test("ATIF keeps root and sibling when a descendant exceeds the embedded cap", () => {
  const deep =
    '{"steps":[],"subagent_trajectories":['.repeat(30000) + '{"steps":[]}' + "]}".repeat(30000);
  const document = parseAtifDocument(
    "root",
    '{"steps":[],"subagent_trajectories":[' + deep + ',{"trajectory_id":"sibling","steps":[]}]}',
  );
  expect(document.sessions).toHaveLength(MAX_ATIF_EMBEDDED_DEPTH + 2);
  expect(document.sessions.at(-1)?.key).toBe("sibling");
  expect(document.sessions.flatMap((s) => s.parsed.issues).map((i) => i.error)).toEqual([
    "embedded trajectories exceed the depth limit",
  ]);
});

test("file budget rejects a sparse oversized file without reading it", () => {
  const dir = mkdtempSync(join(tmpdir(), "decant-limit-"));
  const fd = openSync(join(dir, "large.jsonl"), "w+");
  try {
    ftruncateSync(fd, MAX_SOURCE_FILE_BYTES + 1);
    expect(readSourceFile(fd)).toBeNull();
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true });
  }
});

test("Cursor skips an oversized blob before decoding and keeps its next message", () => {
  const dir = mkdtempSync(join(tmpdir(), "decant-cursor-limit-"));
  try {
    const path = join(dir, "store.db");
    writeCursorStore(path, {}, [
      { role: "user", content: secret + "x".repeat(MAX_RECORD_BYTES) },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    const parsed = parseCursorSession("limits", readCursorSource(path));
    expect(parsed.session.messages).toHaveLength(1);
    expect(parsed.issues).toEqual([
      { code: "unparsed_line", lineNo: 1, error: "record exceeds the byte limit", rawLine: null },
    ]);
    expect(JSON.stringify(parsed.issues)).not.toContain(secret);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("unknown identifiers stay readable and other labels hide their content", () => {
  for (const label of ["future-type", "api.request:v2", "A" + "x".repeat(63)]) {
    expect(printableType(label)).toBe(label);
  }
  for (const label of ["", "_prefix", "a".repeat(65), "private words", "line\nbreak"]) {
    expect(printableType(label)).toMatch(/^\(unprintable type\) sha256:[0-9a-f]{12}$/);
  }
});
