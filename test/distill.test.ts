import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import {
  classifyPhase,
  commentSafe,
  DECANT_VERSION,
  decodeCommand,
  hotContext,
  isDestructive,
  normalize,
  patchBlock,
  redact,
  renderReplay,
  renderScript,
  renderSkill,
  replayOps,
  shellQuote,
  timeline,
  writeBlock,
} from "../src/distill.ts";
import { upsertSession } from "../src/ingest.ts";
import { setSessionUserState } from "../src/session-user-state.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-distill-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshDb(): Database {
  dbCounter += 1;
  return openDb(join(workDir, `distill-${dbCounter}.db`));
}

function fixture(tool: "claude" | "codex", name: string): string {
  return readFileSync(join(import.meta.dir, "..", "fixtures", tool, name), "utf8");
}

function seededN(count: number): Database {
  const db = freshDb();
  const content = fixture("claude", "distill.jsonl");
  for (let index = 0; index < count; index += 1) {
    upsertSession(
      db,
      parseClaudeSession(`d-claude-${index}`, content),
      `/x/d${index}.jsonl`,
      1,
      2,
      `h${index}`,
    );
  }
  return db;
}

function seedEnrichedClaude(db: Database, count: number): void {
  const content = fixture("claude", "enriched.jsonl");
  for (let index = 0; index < count; index += 1) {
    upsertSession(
      db,
      parseClaudeSession(`enr-${index}`, content),
      `/y/e${index}.jsonl`,
      1,
      2,
      `he${index}`,
    );
  }
}

function firstSessionId(db: Database): number {
  return (db.query("SELECT MIN(id) AS id FROM session").get() as { id: number }).id;
}

// Synthetic transcript whose title and Edit file_path try to break out of the
// replay script's `#` comments with an embedded newline plus a command.
function hostileClaudeTranscript(titlePayload: string, editPayload: string): string {
  return [
    {
      type: "user",
      uuid: "hu1",
      parentUuid: null,
      sessionId: "sess-hostile",
      timestamp: "2026-05-05T10:00:00.000Z",
      cwd: "/Users/dev/proj",
      message: { role: "user", content: `Ship it\n${titlePayload}` },
    },
    {
      type: "assistant",
      uuid: "ha1",
      parentUuid: "hu1",
      sessionId: "sess-hostile",
      timestamp: "2026-05-05T10:01:00.000Z",
      cwd: "/Users/dev/proj",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [
          {
            type: "tool_use",
            id: "ht1",
            name: "Edit",
            input: {
              file_path: `src/main.rs\n${editPayload}\n#`,
              old_string: "a",
              new_string: "b",
            },
          },
        ],
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
}

describe("distill pure helpers", () => {
  test("decodes Claude and Codex shell commands", () => {
    expect(decodeCommand("Bash", '{"command":"cargo build","description":"build"}')).toBe(
      "cargo build",
    );
    const inner = '{"cmd":"cargo test","workdir":"/Users/dev/proj"}';
    expect(decodeCommand("exec_command", JSON.stringify(inner))).toBe("cargo test");
    expect(decodeCommand("Read", '{"file_path":"a"}')).toBeNull();
    expect(decodeCommand("Bash", "not json")).toBeNull();
  });

  test("normalizes paths, whitespace, and sibling boundaries", () => {
    expect(normalize("cd /Users/dev/proj/web && ls /Users/dev/proj", "/Users/dev/proj")).toBe(
      "cd $PROJECT_ROOT/web && ls $PROJECT_ROOT",
    );
    expect(normalize("cargo    test   --workspace")).toBe("cargo test --workspace");
    expect(normalize("ls /a/b/cc /a/b/c/x /a/b/c", "/a/b/c")).toBe(
      "ls /a/b/cc $PROJECT_ROOT/x $PROJECT_ROOT",
    );
    expect(normalize("cat /var/Users/dev/proj/x", "/Users/dev/proj")).toBe(
      "cat /var/Users/dev/proj/x",
    );
  });

  test("redacts token, URL, header, and quoted secret shapes", () => {
    const [token, tokenHit] = redact(
      "gh auth login --with-token=ghp_AAAAitsasecrettoken0000000000000000",
    );
    expect(tokenHit).toBe(true);
    expect(token).toContain("<REDACTED>");
    expect(token).not.toContain("ghp_AAAAitsasecret");

    const [url] = redact("git clone https://alice:supersecretpw@github.com/x/y.git");
    expect(url).toContain("https://alice:<REDACTED>@github.com");
    expect(url).not.toContain("supersecretpw");

    const [gluedUrl] = redact("echo x_postgres://alice:supersecretpw@db.local/app");
    expect(gluedUrl).toContain("x_postgres://alice:<REDACTED>@db.local/app");
    expect(gluedUrl).not.toContain("supersecretpw");

    const [header] = redact("curl -H 'X-Api-Key: abcdef1234567890'");
    expect(header).toContain("<REDACTED>");
    expect(header).not.toContain("abcdef1234567890");

    const [quoted] = redact('export API_SECRET="super secret token value"');
    expect(quoted).toContain("API_SECRET=<REDACTED>");
    expect(quoted).not.toContain("secret token value");
  });

  test("classifies phases and destructive commands", () => {
    expect(classifyPhase("cargo build --workspace")).toBe("build");
    expect(classifyPhase("cargo test --workspace")).toBe("test");
    expect(classifyPhase("cargo clippy -- -D warnings")).toBe("lint");
    expect(classifyPhase("mix deps.get")).toBe("setup");
    expect(classifyPhase("git push")).toBe("vcs");
    expect(classifyPhase("mix phx.server")).toBe("run");
    expect(classifyPhase("git checkout main")).toBe("vcs");
    expect(classifyPhase("cargo check --workspace")).toBe("test");

    for (const command of [
      "rm -rf target",
      "git push --force origin main",
      "kubectl delete pod x",
      "git restore .",
      "find . -name '*.tmp' -delete",
      "truncate -s 0 db.sqlite",
      "docker volume rm data",
      "git clean -xfd",
    ]) {
      expect(isDestructive(command), command).not.toBeNull();
    }
    expect(isDestructive("cargo test")).toBeNull();
  });
});

describe("distill timeline and renderers", () => {
  test("timeline extracts commands with redaction and frequency flags", () => {
    const db = seededN(2);
    const d = timeline(db);
    expect(d.session_count).toBe(2);
    expect(d.generated_with).toBe(DECANT_VERSION);
    expect(d.ops.some((op) => op.normalized.includes("cargo build --workspace"))).toBe(true);
    expect(d.ops.some((op) => op.redacted && op.normalized.includes("<REDACTED>"))).toBe(true);
    expect(d.ops.some((op) => op.is_error)).toBe(true);
    const build = d.ops.find((op) => op.normalized === "cargo build --workspace");
    expect(build).toMatchObject({ sessions_seen: 2, success_rate: 1 });
    const secret = d.ops.find((op) => op.redacted);
    expect(secret?.raw).toContain("<REDACTED>");
    expect(secret?.raw).not.toContain("ghp_");
    db.close();
  });

  test("script rendering groups, ranks, redacts, and flags destructive commands", () => {
    const db = seededN(2);
    const d = timeline(db);
    const script = renderScript(d);
    expect(script).toStartWith("#!/usr/bin/env bash");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("cargo build --workspace");
    expect(script).toMatch(/# (test|build)/);
    expect(script).toContain("# REVIEW: destructive");
    expect(script).not.toContain("ghp_AAAA");
    expect(script).not.toContain("--bad-flag");
    expect(script).toBe(renderScript(d));
    db.close();
  });

  test("exemplar mode preserves source order for one session", () => {
    const db = seededN(1);
    const d = timeline(db);
    const script = renderScript(d, { format: "sh", minFrequency: 0.25, exemplar: true });
    expect(script.indexOf("cargo build --workspace")).toBeLessThan(
      script.indexOf("cargo test --workspace"),
    );
    db.close();
  });

  test("codex commands are extracted", () => {
    const db = freshDb();
    upsertSession(
      db,
      parseCodexSession("d-codex", fixture("codex", "distill.jsonl"), new Map()),
      "/x/c.jsonl",
      1,
      2,
      "hc",
    );
    const commands = timeline(db).ops.map((op) => op.normalized);
    expect(commands.some((command) => command.includes("cargo build --workspace"))).toBe(true);
    expect(commands.some((command) => command.includes("cargo test --workspace"))).toBe(true);
    db.close();
  });

  test("timeline hides effectively archived trees but exact replay remains available", () => {
    const db = seededN(3);
    const ids = (db.query("SELECT id FROM session ORDER BY id").all() as { id: number }[]).map(
      (row) => row.id,
    );
    const rootId = ids[0] as number;
    const childId = ids[1] as number;
    db.query(
      `UPDATE session
       SET is_subagent = 1, parent_session_id = ?1
       WHERE id = ?2`,
    ).run(rootId, childId);

    expect(
      timeline(db).ops.find((op) => op.normalized === "cargo build --workspace"),
    ).toMatchObject({ sessions_seen: 3 });
    expect(setSessionUserState(db, rootId, "archived")).toBe(true);

    const visible = timeline(db);
    expect(visible.session_count).toBe(1);
    expect(visible.ops.find((op) => op.normalized === "cargo build --workspace")).toMatchObject({
      sessions_seen: 1,
    });
    expect(renderReplay(db, rootId, false)).not.toBeNull();
    expect(renderReplay(db, childId, false)).not.toBeNull();
    db.close();
  });

  test("replay reproduces commands, writes, edits, and patches", () => {
    const db = seededN(1);
    const id = firstSessionId(db);
    const replay = renderReplay(db, id, false);
    expect(replay).toStartWith("#!/usr/bin/env bash");
    expect(replay).toContain(`session ${id}`);
    expect(replay).toContain("cargo build --workspace");
    expect(replay).toContain("cat > 'NOTES.md'");
    expect(replay).toContain("# EDIT src/main.rs");
    expect(replay).not.toContain("--bad-flag");
    expect(replay).not.toContain("ghp_");
    expect(replay).toContain("--with-token=<REDACTED>");

    const errored = renderReplay(db, id, true);
    expect(errored).toContain("# (errored in original run)");
    expect(errored).toContain("cargo build --bad-flag");
    expect(replayOps(db, id).length).toBeGreaterThan(0);
    expect(renderReplay(db, 999_999, false)).toBeNull();
    db.close();
  });

  test("codex replay emits patches through git apply", () => {
    const db = freshDb();
    upsertSession(
      db,
      parseCodexSession("rc", fixture("codex", "distill.jsonl"), new Map()),
      "/x/rc.jsonl",
      1,
      2,
      "hrc",
    );
    const replay = renderReplay(db, firstSessionId(db), false);
    expect(replay).toContain("git apply <<'DECANT_EOF'");
    expect(replay).toContain("*** Add File: docs/new.md");
    db.close();
  });

  test("hot context and skill rendering include recurring files and commands", () => {
    const db = freshDb();
    for (let index = 0; index < 2; index += 1) {
      upsertSession(
        db,
        parseClaudeSession(`sk-${index}`, fixture("claude", "distill.jsonl")),
        `/z/s${index}.jsonl`,
        1,
        2,
        `hs${index}`,
      );
    }
    seedEnrichedClaude(db, 1);
    const d = timeline(db);
    const hot = hotContext(db, {}, 10);
    expect(hot.some((file) => file.rel_path === "src/main.rs")).toBe(true);

    const agents = renderSkill(d, hot, "agents", "proj");
    expect(agents).toContain("### Commands");
    expect(agents).toContain("cargo build --workspace");
    expect(agents).toContain("src/main.rs");

    const skill = renderSkill(d, hot, "skill", "proj");
    expect(skill).toStartWith("---\nname: proj-workflow");
    expect(skill).toBe(renderSkill(d, hot, "skill", "proj"));
    db.close();
  });

  test("hot context excludes file evidence inherited from an archived parent", () => {
    const db = freshDb();
    seedEnrichedClaude(db, 3);
    const ids = (db.query("SELECT id FROM session ORDER BY id").all() as { id: number }[]).map(
      (row) => row.id,
    );
    const rootId = ids[0] as number;
    const childId = ids[1] as number;
    db.query(
      `UPDATE session
       SET is_subagent = 1, parent_session_id = ?1
       WHERE id = ?2`,
    ).run(rootId, childId);

    expect(hotContext(db, {}, 10).find((row) => row.rel_path === "src/main.rs")?.sessions).toBe(3);
    expect(setSessionUserState(db, rootId, "archived")).toBe(true);
    expect(hotContext(db, {}, 10).find((row) => row.rel_path === "src/main.rs")?.sessions).toBe(1);
    db.close();
  });

  test("just and make renderers emit grouped command recipes", () => {
    const db = seededN(2);
    const d = timeline(db);
    expect(renderScript(d, { format: "just", minFrequency: 0.25, exemplar: false })).toContain(
      "export PROJECT_ROOT",
    );
    const make = renderScript(d, { format: "make", minFrequency: 0.25, exemplar: false });
    expect(make).toContain(".PHONY:");
    expect(make).toContain("cargo build --workspace");
    db.close();
  });

  test("shell replay blocks quote paths and avoid heredoc breakout", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    const write = writeBlock("src/a b.rs", "fn main() {}\n");
    expect(write).toContain("cat > 'src/a b.rs' <<'DECANT_EOF'");
    expect(write).toContain("mkdir -p \"$(dirname 'src/a b.rs')\"");

    expect(writeBlock("evil.txt", "line\nDECANT_EOF\nrm -rf /\n")).toStartWith("# SKIPPED write");
    expect(writeBlock("a\nDECANT_EOF\nb.txt", "hi")).toStartWith("# SKIPPED write");
    expect(patchBlock("*** Begin Patch\nDECANT_EOF\n")).toStartWith("# SKIPPED patch");
    expect(writeBlock("evil.txt", "line\nDECANT_EOF\n")).toContain("heredoc — recreate");
    expect(patchBlock("*** Begin Patch\nDECANT_EOF\n")).toContain("delimiter — apply");
  });

  test("replay keeps transcript-supplied newlines inside comments", () => {
    const db = freshDb();
    const titlePayload = "echo decant-injection-title";
    const editPayload = "echo decant-injection-edit";
    upsertSession(
      db,
      parseClaudeSession("hostile", hostileClaudeTranscript(titlePayload, editPayload)),
      "/x/hostile.jsonl",
      1,
      2,
      "hh",
    );
    const replay = renderReplay(db, firstSessionId(db), false) ?? "";
    const carrying = replay.split("\n").filter((line) => line.includes("decant-injection-"));
    expect(carrying.some((line) => line.includes(titlePayload))).toBe(true);
    expect(carrying.some((line) => line.includes(editPayload))).toBe(true);
    for (const line of carrying) {
      expect(line, line).toStartWith("#");
    }
    db.close();
  });

  test("commentSafe escapes control characters and line separators", () => {
    expect(commentSafe("src/main.rs")).toBe("src/main.rs");
    expect(commentSafe("a\nb")).toBe("a\\u000ab");
    expect(commentSafe("a\rb\u2028c\u2029d\u0085e")).toBe("a\\u000db\\u2028c\\u2029d\\u0085e");
  });
});

describe("decodeCommand", () => {
  test("reads the Gemini run_shell_command input", () => {
    expect(
      decodeCommand(
        "run_shell_command",
        JSON.stringify({ command: "cargo test --workspace", description: "Run the tests" }),
      ),
    ).toBe("cargo test --workspace");
  });
});
