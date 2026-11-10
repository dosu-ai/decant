import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import { exportAtif } from "../src/export-atif.ts";
import { sync } from "../src/ingest.ts";
import {
  normalizeRemoteUrl,
  remoteUrlFromGitConfig,
  resolveProjectRemotes,
  resolveRepoRemote,
} from "../src/repo-remote.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "decant-remote-")));
  tempRoots.push(dir);
  return dir;
}

function origin(url: string): string {
  return `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
}

/** A repository at `dir` whose config is `config`. */
function repo(dir: string, config: string): string {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), config);
  return dir;
}

/** A linked worktree of `root` at `dir`, laid out as `git worktree add` does. */
function worktree(root: string, dir: string, name: string): string {
  const gitDir = join(root, ".git", "worktrees", name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: ${gitDir}\n`);
  return dir;
}

describe("normalizeRemoteUrl", () => {
  test("gives every spelling of one remote the same identity", () => {
    for (const url of [
      "https://github.com/acme/widget.git",
      "https://github.com/acme/widget",
      "https://GitHub.com/acme/widget/",
      "git@github.com:acme/widget.git",
      "ssh://git@github.com/acme/widget.git",
      "ssh://git@github.com:22/acme/widget",
      "git://github.com/acme/widget.git",
      "  https://github.com/acme/widget.git?ref=main#readme  ",
    ]) {
      expect(normalizeRemoteUrl(url)).toBe("github.com/acme/widget");
    }
  });

  test("drops credentials embedded in the URL", () => {
    expect(
      normalizeRemoteUrl("https://synthetic-user:synthetic-token@github.com/acme/widget.git"),
    ).toBe("github.com/acme/widget");
    expect(normalizeRemoteUrl("https://synthetic-token@gitlab.example/group/sub/widget")).toBe(
      "gitlab.example/group/sub/widget",
    );
  });

  test("keeps nested groups and the path's case", () => {
    expect(normalizeRemoteUrl("git@gitlab.example:Group/Sub/Widget.git")).toBe(
      "gitlab.example/Group/Sub/Widget",
    );
  });

  test("rejects remotes that name nothing off this machine", () => {
    for (const url of [
      "",
      "/srv/git/widget.git",
      "../widget",
      "file:///srv/git/widget.git",
      "C:\\repos\\widget",
      "https://github.com/",
      "git@github.com:",
      "git@github.com:acme/wid get",
    ]) {
      expect(normalizeRemoteUrl(url)).toBeNull();
    }
  });
});

describe("remoteUrlFromGitConfig", () => {
  test("reads origin among several remotes", () => {
    const config = [
      '[remote "upstream"]',
      "\turl = https://github.com/upstream/widget.git",
      "; a comment",
      '[remote "origin"]',
      '\turl = "git@github.com:acme/widget.git" # mine',
      "\tpushurl = git@github.com:acme/elsewhere.git",
      '[branch "main"]',
      "\turl = not-a-remote",
    ].join("\n");
    expect(remoteUrlFromGitConfig(config)).toBe("git@github.com:acme/widget.git");
  });

  test("falls back to the only remote, and to nothing when several compete", () => {
    expect(remoteUrlFromGitConfig('[remote "fork"]\r\n\turl = https://example.test/a/b\r\n')).toBe(
      "https://example.test/a/b",
    );
    expect(
      remoteUrlFromGitConfig(
        '[remote "one"]\n\turl = https://example.test/a/b\n[remote "two"]\n\turl = https://example.test/c/d\n',
      ),
    ).toBeNull();
    expect(remoteUrlFromGitConfig("[core]\n\tbare = false\n")).toBeNull();
  });
});

describe("resolveRepoRemote", () => {
  test("reads a repository from its root and from a directory inside it", () => {
    const root = repo(join(tempDir(), "widget"), origin("git@github.com:acme/widget.git"));
    mkdirSync(join(root, "packages", "core"), { recursive: true });
    expect(resolveRepoRemote(root)).toBe("github.com/acme/widget");
    expect(resolveRepoRemote(join(root, "packages", "core"))).toBe("github.com/acme/widget");
  });

  test("follows a linked worktree to the config its repository shares", () => {
    const base = tempDir();
    const root = repo(join(base, "widget"), origin("https://github.com/acme/widget.git"));
    const leaf = worktree(root, join(base, "trees", "feature"), "feature");
    expect(resolveRepoRemote(leaf)).toBe("github.com/acme/widget");
  });

  test("answers nothing for a directory that is gone, even inside a repository", () => {
    const root = repo(join(tempDir(), "home"), origin("git@github.com:acme/dotfiles.git"));
    expect(resolveRepoRemote(join(root, "worktrees", "removed"))).toBeNull();
  });

  test("answers nothing without a repository, a remote, or an absolute path", () => {
    const base = tempDir();
    expect(resolveRepoRemote(base)).toBeNull();
    expect(resolveRepoRemote(repo(join(base, "local"), "[core]\n\tbare = false\n"))).toBeNull();
    expect(resolveRepoRemote("relative/path")).toBeNull();
  });

  test("does not read an oversized config", () => {
    const root = repo(
      join(tempDir(), "big"),
      `${origin("git@github.com:acme/widget.git")}${"# padding\n".repeat(40_000)}`,
    );
    expect(resolveRepoRemote(root)).toBeNull();
  });
});

describe("resolveProjectRemotes", () => {
  function tempDb(): Database {
    return openDb(join(tempDir(), "test.db"));
  }

  function addProject(
    db: Database,
    id: number,
    path: string,
    rootPath: string,
    tool = "claude_code",
  ) {
    db.query("INSERT INTO project(id, path, name, root_path) VALUES (?1, ?2, 'p', ?3)").run(
      id,
      path,
      rootPath,
    );
    db.query(
      "INSERT INTO session(id, tool, source_session_id, project_id) VALUES (?1, ?2, ?3, ?1)",
    ).run(id, tool, `session-${id}`);
  }

  function remotes(db: Database): Record<string, string | null> {
    return Object.fromEntries(
      (
        db.query("SELECT id, repo_remote FROM project ORDER BY id").all() as {
          id: number;
          repo_remote: string | null;
        }[]
      ).map((row) => [row.id, row.repo_remote]),
    );
  }

  test("records live projects and lends a removed worktree its root's identity", () => {
    const base = tempDir();
    const root = repo(join(base, "widget"), origin("git@github.com:acme/widget.git"));
    const db = tempDb();
    try {
      addProject(db, 1, root, root);
      addProject(db, 2, join(base, "trees", "removed"), root);
      addProject(db, 3, join(base, "not-a-repo"), join(base, "not-a-repo"));
      // A removed worktree whose root is only a guessed name has nothing to borrow.
      addProject(db, 4, join(base, "trees", "orphan"), "widget");
      resolveProjectRemotes(db);
      expect(remotes(db)).toEqual({
        1: "github.com/acme/widget",
        2: "github.com/acme/widget",
        3: null,
        4: null,
      });
    } finally {
      closeDb(db);
    }
  });

  test("keeps a recorded identity when the checkout is gone, and follows a changed remote", () => {
    const base = tempDir();
    const root = repo(join(base, "widget"), origin("git@github.com:acme/widget.git"));
    const db = tempDb();
    try {
      addProject(db, 1, root, root);
      resolveProjectRemotes(db);
      writeFileSync(join(root, ".git", "config"), origin("git@github.com:acme/renamed.git"));
      resolveProjectRemotes(db);
      expect(remotes(db)).toEqual({ 1: "github.com/acme/renamed" });

      rmSync(root, { recursive: true, force: true });
      resolveProjectRemotes(db);
      expect(remotes(db)).toEqual({ 1: "github.com/acme/renamed" });
    } finally {
      closeDb(db);
    }
  });

  test("leaves a project of imported ATIF trajectories alone", () => {
    const root = repo(join(tempDir(), "bench"), origin("git@github.com:acme/bench.git"));
    const jobs = join(root, "jobs", "run-1");
    mkdirSync(jobs, { recursive: true });
    const db = tempDb();
    try {
      addProject(db, 1, jobs, jobs, "atif");
      resolveProjectRemotes(db);
      expect(remotes(db)).toEqual({ 1: null });
    } finally {
      closeDb(db);
    }
  });

  test("sync records the remote of a session's working directory, and ATIF exports carry it", () => {
    const base = tempDir();
    const root = repo(
      join(base, "widget"),
      origin("https://synthetic-token@github.com/acme/widget.git"),
    );
    const codexDir = join(base, "codex");
    const rollout = join(codexDir, "sessions", "2026", "07", "29", "rollout-remote.jsonl");
    mkdirSync(join(rollout, ".."), { recursive: true });
    writeFileSync(
      rollout,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "remote-session", cwd: root } }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-29T09:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Where does this live?" }],
          },
        }),
      ].join("\n"),
    );
    const db = tempDb();
    try {
      expect(sync(db, { claudeDir: join(base, "claude"), codexDir })).toMatchObject({
        ingested: 1,
        failed: 0,
      });
      expect(db.query("SELECT path, repo_remote FROM project").all()).toEqual([
        { path: root, repo_remote: "github.com/acme/widget" },
      ]);
      const { id } = db.query("SELECT id FROM session").get() as { id: number };
      const out = exportAtif(db, id);
      if (!out.ok) throw new Error(out.reason);
      expect(out.trajectory.extra).toMatchObject({
        cwd: root,
        repository: "github.com/acme/widget",
      });
      expect(JSON.stringify(out.trajectory)).not.toContain("synthetic-token");
    } finally {
      closeDb(db);
    }
  });
});
