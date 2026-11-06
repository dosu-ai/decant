import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import {
  basename,
  classifyExternal,
  classifyIntree,
  externalContainer,
  inferTool,
  type KnownRoot,
  resolveGitRoot,
  resolveWorktreeRoots,
} from "../src/worktree.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function tempDb(): Database {
  return openDb(join(tempDir("decant-worktree-db-"), "test.db"));
}

function pathRow(db: Database, path: string): [number, string, string | null, string | null] {
  const row = db
    .query("SELECT is_worktree, root_path, worktree_tool, root_source FROM project WHERE path = ?1")
    .get(path) as {
    is_worktree: number;
    root_path: string;
    worktree_tool: string | null;
    root_source: string | null;
  };
  return [row.is_worktree, row.root_path, row.worktree_tool, row.root_source];
}

describe("worktree pure classifiers", () => {
  test("intree claude worktree recovers root and label", () => {
    const result = classifyIntree("/Users/dev/acme/app/.claude-worktrees/feature-auth");
    expect(result).toMatchObject({
      isWorktree: true,
      rootPath: "/Users/dev/acme/app",
      worktreeLabel: "feature-auth",
      worktreeTool: "claude",
      source: "intree",
    });
  });

  test("intree plain git worktree uses git tool", () => {
    const result = classifyIntree("/Users/dev/src/decant/.worktrees/feature-x");
    expect(result).toMatchObject({
      rootPath: "/Users/dev/src/decant",
      worktreeLabel: "feature-x",
      worktreeTool: "git",
      source: "intree",
    });
  });

  test("intree codex worktree recovers root and label", () => {
    const result = classifyIntree("/Users/dev/src/decant/.codex-worktrees/feature-token-ui");
    expect(result).toMatchObject({
      rootPath: "/Users/dev/src/decant",
      worktreeLabel: "feature-token-ui",
      worktreeTool: "codex",
      source: "intree",
    });
  });

  test("plain path is not intree", () => {
    expect(classifyIntree("/Users/dev/src/decant")).toBeNull();
  });

  test("external container detects warp conductor and t3", () => {
    expect(externalContainer("/Users/dev/.warp-worktrees/dosu-feature-api")).toEqual({
      tool: "warp",
      leaf: "dosu-feature-api",
    });
    expect(externalContainer("/Users/dev/conductor/workspaces/dosu-feature-ui")).toEqual({
      tool: "conductor",
      leaf: "dosu-feature-ui",
    });
    expect(externalContainer("/Users/dev/.t3-worktrees/dosu-t3code-abcdef12")).toEqual({
      tool: "t3",
      leaf: "dosu-t3code-abcdef12",
    });
    expect(externalContainer("/Users/dev/src/decant")).toBeNull();
  });

  test("external container detects nested warp layout", () => {
    expect(externalContainer("/Users/dev/.warp/worktrees/skymap/feature-report")).toEqual({
      tool: "warp",
      leaf: "skymap-feature-report",
      repo: "skymap",
    });
    expect(externalContainer("/Users/dev/.warp/worktrees/skymap")).toBeNull();
    expect(externalContainer("/Users/dev/src/worktrees/decant")).toBeNull();
  });

  test("external container detects the ~/.t3/worktrees layout", () => {
    expect(externalContainer("/Users/dev/.t3/worktrees/decant/t3-0cacd467")).toEqual({
      tool: "t3",
      leaf: "decant-t3-0cacd467",
      repo: "decant",
    });
    expect(externalContainer("/Users/dev/.t3/worktrees/decant")).toBeNull();
    // A removed worktree no longer resolves through git, so the name decides.
    const known: KnownRoot[] = [
      { path: "/Users/dev/src/decant", basename: "decant", sessions: 3, lastSeen: "2026-06-01" },
    ];
    expect(classifyExternal("t3", "decant-t3-0cacd467", "/x", known, "decant")).toMatchObject({
      source: "namematch",
      rootPath: "/Users/dev/src/decant",
      worktreeLabel: "t3-0cacd467",
      worktreeTool: "t3",
    });
    expect(classifyExternal("t3", "decant-t3-0cacd467", "/x", [], "decant")).toMatchObject({
      source: "synthetic",
      rootPath: "decant",
      worktreeLabel: "t3-0cacd467",
    });
    // The repository segment wins over a longer name that happens to prefix the leaf.
    const lookalike: KnownRoot[] = [
      ...known,
      {
        path: "/Users/dev/src/decant-t3",
        basename: "decant-t3",
        sessions: 9,
        lastSeen: "2026-07-01",
      },
    ];
    expect(classifyExternal("t3", "decant-t3-0cacd467", "/x", lookalike, "decant")).toMatchObject({
      source: "namematch",
      rootPath: "/Users/dev/src/decant",
      worktreeLabel: "t3-0cacd467",
    });
  });

  test("external container detects Codex worktree layouts", () => {
    expect(externalContainer("/Users/dev/.codex-worktrees/decant-token-ui")).toEqual({
      tool: "codex",
      leaf: "decant-token-ui",
    });
    expect(externalContainer("/Users/dev/.codex/worktrees/decant/token-ui")).toEqual({
      tool: "codex",
      leaf: "decant-token-ui",
      repo: "decant",
    });
    expect(externalContainer("/Users/dev/.codex/worktrees/decant")).toBeNull();
  });

  test("nested warp leaf name-matches known root", () => {
    const roots: KnownRoot[] = [
      {
        path: "/Users/dev/src/skymap",
        basename: "skymap",
        sessions: 10,
        lastSeen: "2026-06-01",
      },
    ];
    const container = externalContainer("/Users/dev/.warp/worktrees/skymap/feature-report");
    expect(container).not.toBeNull();
    const result = classifyExternal(container?.tool ?? "", container?.leaf ?? "", "/x", roots);
    expect(result).toMatchObject({
      source: "namematch",
      rootPath: "/Users/dev/src/skymap",
      worktreeLabel: "feature-report",
      worktreeTool: "warp",
    });
  });

  test("nested warp leaf resolves synthetically without a known root", () => {
    const container = externalContainer("/Users/dev/.warp/worktrees/skymap/feature-report");
    expect(container).not.toBeNull();
    const result = classifyExternal(container?.tool ?? "", container?.leaf ?? "", "/x", []);
    expect(result).toMatchObject({
      source: "synthetic",
      rootPath: "skymap",
      worktreeLabel: "feature-report",
    });
  });

  test("external name-matches known root", () => {
    const roots: KnownRoot[] = [
      {
        path: "/Users/dev/acme/app",
        basename: "dosu",
        sessions: 10,
        lastSeen: "2026-06-01",
      },
    ];
    const result = classifyExternal(
      "warp",
      "dosu-feature-api",
      "/Users/dev/.warp-worktrees/dosu-feature-api",
      roots,
    );
    expect(result).toMatchObject({
      isWorktree: true,
      source: "namematch",
      rootPath: "/Users/dev/acme/app",
      worktreeLabel: "feature-api",
      worktreeTool: "warp",
    });
  });

  test("external name-match longest basename wins", () => {
    const roots: KnownRoot[] = [
      { path: "/u/sample", basename: "sample", sessions: 100, lastSeen: "2026-06-01" },
      {
        path: "/u/sample-addon",
        basename: "sample-addon",
        sessions: 1,
        lastSeen: "2026-01-01",
      },
    ];
    const result = classifyExternal("warp", "sample-addon-feature", "/x", roots);
    expect(result.rootPath).toBe("/u/sample-addon");
    expect(result.worktreeLabel).toBe("feature");
  });

  test("external name-match tie-breaks on sessions recency then path", () => {
    const sessions: KnownRoot[] = [
      { path: "/Users/dev/acme", basename: "dosu", sessions: 2, lastSeen: "2026-06-01" },
      {
        path: "/Users/dev/acme/app",
        basename: "dosu",
        sessions: 40,
        lastSeen: "2026-05-01",
      },
    ];
    expect(classifyExternal("warp", "dosu-feature-api", "/x", sessions).rootPath).toBe(
      "/Users/dev/acme/app",
    );

    const recency: KnownRoot[] = [
      { path: "/u/a/dosu", basename: "dosu", sessions: 5, lastSeen: "2026-01-01" },
      { path: "/u/b/dosu", basename: "dosu", sessions: 5, lastSeen: "2026-06-01" },
    ];
    expect(classifyExternal("warp", "dosu-feature-api", "/x", recency).rootPath).toBe("/u/b/dosu");

    const tie = (order: string[]) =>
      classifyExternal(
        "warp",
        "dosu-feature-api",
        "/x",
        order.map((path) => ({
          path,
          basename: "dosu",
          sessions: 5,
          lastSeen: "2026-06-01",
        })),
      ).rootPath;
    expect(tie(["/u/a/dosu", "/u/b/dosu"])).toBe(tie(["/u/b/dosu", "/u/a/dosu"]));
  });

  test("external synthetic strips codename per tool", () => {
    expect(classifyExternal("warp", "dosu-feature-api", "/x", []).rootPath).toBe("dosu");
    expect(classifyExternal("t3", "dosu-t3code-abcdef12", "/x", []).rootPath).toBe("dosu");
    expect(classifyExternal("conductor", "sample-ui", "/x", []).rootPath).toBe("sample");
    const result = classifyExternal("warp", "dosu-feature-api", "/x", []);
    expect(result.source).toBe("synthetic");
    expect(result.worktreeLabel).toBe("feature-api");
  });

  test("source strings and path edge cases", () => {
    expect(classifyIntree("repo/.worktrees/feature-y")).toMatchObject({
      rootPath: "repo",
      worktreeLabel: "feature-y",
      worktreeTool: "git",
    });
    expect(classifyIntree("/.worktrees/feature")).toBeNull();
    expect(classifyIntree("/Users/x/repo/.worktrees")).toBeNull();
    expect(externalContainer("/Users/x/.warp-worktrees")).toBeNull();
    expect(classifyExternal("t3", "plainname", "/x", []).rootPath).toBe("plainname");
    expect(classifyExternal("warp", "one-two", "/x", []).rootPath).toBe("one-two");
    expect(classifyExternal("conductor", "solo", "/x", []).rootPath).toBe("solo");
    expect(classifyExternal("unknown-tool", "whatever", "/x", []).rootPath).toBe("whatever");
    const empty = classifyExternal("conductor", "-x", "/Users/x/conductor/workspaces/-x", []);
    expect(empty.rootPath).toBe("/Users/x/conductor/workspaces/-x");
    expect(empty.worktreeLabel).toBeNull();
    expect(basename("/u/x/dosu/")).toBe("dosu");
    expect(basename("dosu")).toBe("dosu");
    expect(basename("")).toBe("");
  });
});

describe("git worktree pointer resolution", () => {
  test("git pointer file resolves authoritative root", () => {
    const root = tempDir("decant-worktree-git-");
    const wt = join(root, "feature-api");
    mkdirSync(wt, { recursive: true });
    writeFileSync(wt.concat("/.git"), "gitdir: /Users/dev/acme/app/.git/worktrees/feature-api\n");
    const result = resolveGitRoot(wt);
    expect(result).toMatchObject({
      isWorktree: true,
      rootPath: "/Users/dev/acme/app",
      worktreeLabel: "feature-api",
      worktreeTool: "git",
      source: "git",
    });
  });

  test("git directory missing or non-worktree returns null", () => {
    const main = tempDir("decant-main-git-");
    mkdirSync(join(main, ".git"), { recursive: true });
    expect(resolveGitRoot(main)).toBeNull();

    const missing = tempDir("decant-missing-git-");
    expect(resolveGitRoot(missing)).toBeNull();
    writeFileSync(join(missing, ".git"), "gitdir: ../.git/modules/foo\n");
    expect(resolveGitRoot(missing)).toBeNull();
  });

  test("git pointer in external container infers container tool", () => {
    const root = tempDir("decant-warp-git-");
    const wt = join(root, ".warp-worktrees", "dosu-feature-api");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /Users/dev/acme/app/.git/worktrees/feature-api\n");
    expect(resolveGitRoot(wt)).toMatchObject({
      worktreeTool: "warp",
      rootPath: "/Users/dev/acme/app",
    });
  });

  test("git pointer unusual forms", () => {
    const root = tempDir("decant-pointer-");
    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });

    writeFileSync(join(wt, ".git"), "gitdir: /.git/worktrees/wt\n");
    expect(resolveGitRoot(wt)).toBeNull();

    writeFileSync(join(wt, ".git"), "gitdir: /Users/x/repo/.git/worktrees/\n");
    expect(resolveGitRoot(wt)).toBeNull();

    writeFileSync(join(wt, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
    expect(resolveGitRoot(wt)).toBeNull();

    writeFileSync(join(wt, ".git"), "gitdir:/Users/x/repo/.git/worktrees/wt\r\n");
    expect(resolveGitRoot(wt)).toMatchObject({
      rootPath: "/Users/x/repo",
      worktreeLabel: "wt",
    });
  });

  test("infer tool defaults and recognizes segments", () => {
    expect(inferTool("/u/.warp-worktrees/dosu-x")).toBe("warp");
    expect(inferTool("/u/repo/.claude-worktrees/x")).toBe("claude");
    expect(inferTool("/u/repo/.codex-worktrees/x")).toBe("codex");
    expect(inferTool("/u/.codex/worktrees/dosu/x")).toBe("codex");
    expect(inferTool("/u/repo/plain")).toBe("git");
  });
});

describe("resolveWorktreeRoots", () => {
  test("links intree and external worktrees to roots", () => {
    const db = tempDb();
    db.exec(`
      INSERT INTO project(path, name) VALUES ('/home/x/dosu/dosu', 'dosu');
      INSERT INTO project(path, name) VALUES
        ('/home/x/dosu/dosu/.claude-worktrees/feature-auth', 'feature-auth');
      INSERT INTO project(path, name) VALUES
        ('/home/x/.warp-worktrees/dosu-feature-api', 'dosu-feature-api');
    `);
    resolveWorktreeRoots(db);

    expect(pathRow(db, "/home/x/dosu/dosu")).toEqual([0, "/home/x/dosu/dosu", null, "self"]);
    expect(pathRow(db, "/home/x/dosu/dosu/.claude-worktrees/feature-auth")).toEqual([
      1,
      "/home/x/dosu/dosu",
      "claude",
      "intree",
    ]);
    expect(pathRow(db, "/home/x/.warp-worktrees/dosu-feature-api")).toEqual([
      1,
      "/home/x/dosu/dosu",
      "warp",
      "namematch",
    ]);
    db.close();
  });

  test("preserves git locked rows and uses them as targets", () => {
    const db = tempDb();
    db.exec(`
      INSERT INTO project(path, name, is_worktree, root_path, worktree_label, worktree_tool, root_source)
      VALUES ('/gone/wt', 'wt', 1, '/real/dosu', 'wt', 'git', 'git');
      INSERT INTO project(path, name)
      VALUES ('/home/x/.warp-worktrees/dosu-feature-api', 'dosu-feature-api');
    `);
    resolveWorktreeRoots(db);
    resolveWorktreeRoots(db);

    const locked = db
      .query(
        "SELECT is_worktree, root_path, worktree_label, root_source FROM project WHERE path = '/gone/wt'",
      )
      .get() as {
      is_worktree: number;
      root_path: string;
      worktree_label: string | null;
      root_source: string | null;
    };
    expect(locked).toEqual({
      is_worktree: 1,
      root_path: "/real/dosu",
      worktree_label: "wt",
      root_source: "git",
    });

    const external = db
      .query(
        "SELECT root_path, root_source FROM project WHERE path = '/home/x/.warp-worktrees/dosu-feature-api'",
      )
      .get() as { root_path: string; root_source: string };
    expect(external).toEqual({ root_path: "/real/dosu", root_source: "namematch" });
    db.close();
  });

  test("propagates db error", () => {
    const db = new Database(":memory:");
    expect(() => resolveWorktreeRoots(db)).toThrow();
    db.close();
  });

  test("uses on-disk git worktree pointer", () => {
    const root = tempDir("decant-real-git-");
    const wt = join(root, "feature-api");
    mkdirSync(wt, { recursive: true });
    writeFileSync(wt.concat("/.git"), "gitdir: /Users/dev/acme/app/.git/worktrees/feature-api\n");

    const db = tempDb();
    db.query("INSERT INTO project(path, name) VALUES (?1, 'feature-api')").run(wt);
    resolveWorktreeRoots(db);

    const result = db
      .query("SELECT is_worktree, root_path, root_source FROM project WHERE name = 'feature-api'")
      .get() as { is_worktree: number; root_path: string; root_source: string };
    expect(result).toEqual({
      is_worktree: 1,
      root_path: "/Users/dev/acme/app",
      root_source: "git",
    });
    db.close();
  });
});
