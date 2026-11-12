import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_FIELDS, SESSION_FIELDS, textCell } from "../src/cli/list-options.ts";
import { runCli } from "../src/cli.ts";
import { closeDb, openDb } from "../src/db.ts";
import { resolveProjectPath, resolveRepoRoots } from "../src/project-scope.ts";
import { listSessions, search } from "../src/query.ts";

// Every path, title, and remote here is invented. The directories exist only
// so the typed-path cases have something real to resolve.
const base = realpathSync(mkdtempSync(join(tmpdir(), "decant-list-filters-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const home = join(base, "home");
const widget = join(base, "widget");
const feature = join(widget, ".worktrees", "feature");
const external = "/synthetic/.t3/worktrees/widget/t3-0001";
const clone = join(base, "clone", "widget");
const gadget = join(base, "gadget");
const otherGadget = join(base, "other", "gadget");
const orphan = "/synthetic/.t3/worktrees/orphan/t3-0002";
// A repository with no remote, and sessions started in one of its packages.
const local = join(base, "local");
const fresh = join(base, "fresh");
const link = join(base, "link");
const WIDGET_REMOTE = "example.test/acme/widget";

mkdirSync(join(widget, "src"), { recursive: true });
mkdirSync(join(widget, ".git", "worktrees", "fresh"), { recursive: true });
writeFileSync(
  join(widget, ".git", "config"),
  '[remote "origin"]\n\turl = https://example.test/acme/widget.git\n',
);
writeFileSync(join(widget, ".git", "worktrees", "fresh", "commondir"), "../..\n");
// A linked worktree the archive has never seen a session in.
mkdirSync(fresh, { recursive: true });
writeFileSync(join(fresh, ".git"), `gitdir: ${join(widget, ".git", "worktrees", "fresh")}\n`);
mkdirSync(join(local, ".git"), { recursive: true });
mkdirSync(join(local, "pkg"), { recursive: true });
mkdirSync(join(base, "elsewhere"), { recursive: true });
mkdirSync(join(home, "work"), { recursive: true });
symlinkSync(widget, link);

const dbPath = join(base, "archive.db");
// The listing shows a session's first prompt as its title, so each prompt
// doubles as the session's name. Three of them hold the search term.
const SESSIONS: [project: number, day: string, prompt: string][] = [
  [1, "2026-03-01", "widget root one needle"],
  [1, "2026-03-05", "widget root two"],
  [1, "2026-03-10", "widget root three"],
  [2, "2026-03-06", "widget feature worktree needle"],
  [3, "2026-03-07", "widget external worktree"],
  [4, "2026-03-08", "widget second checkout"],
  [5, "2026-03-02", "gadget one needle"],
  [5, "2026-03-09", "gadget two"],
  [6, "2026-03-03", "other gadget"],
  [7, "2026-03-04", "orphan worktree"],
  [8, "2026-03-11", "home work"],
  [9, "2026-03-04", "local root"],
  [10, "2026-03-05", "local package"],
];

{
  const db = openDb(dbPath);
  try {
    const project = db.query(
      `INSERT INTO project(id, path, name, is_worktree, root_path, root_source, repo_remote)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    );
    project.run(1, widget, "widget", 0, widget, "self", WIDGET_REMOTE);
    project.run(2, feature, "feature", 1, widget, "intree", WIDGET_REMOTE);
    project.run(3, external, "t3-0001", 1, widget, "namematch", null);
    project.run(4, clone, "widget", 0, clone, "self", WIDGET_REMOTE);
    project.run(5, gadget, "gadget", 0, gadget, "self", "example.test/acme/gadget");
    project.run(6, otherGadget, "gadget", 0, otherGadget, "self", null);
    project.run(7, orphan, "t3-0002", 1, "orphan", "synthetic", null);
    project.run(8, join(home, "work"), "work", 0, join(home, "work"), "self", null);
    project.run(9, local, "local", 0, local, "self", null);
    project.run(10, join(local, "pkg"), "pkg", 0, join(local, "pkg"), "self", null);
    for (const [index, [projectId, day, prompt]] of SESSIONS.entries()) {
      const sessionId = Number(
        db
          .query(
            `INSERT INTO session(tool, source_session_id, source_path, project_id, title,
                                 started_at, message_count)
             VALUES ('claude_code', ?1, ?2, ?3, ?4, ?5, 1)`,
          )
          .run(
            `synthetic-${index}`,
            `/synthetic/logs/${index}.jsonl`,
            projectId,
            prompt,
            `${day}T12:00:00.000Z`,
          ).lastInsertRowid,
      );
      const messageId = Number(
        db
          .query("INSERT INTO message (session_id, seq, role, raw) VALUES (?1, 0, 'user', '{}')")
          .run(sessionId).lastInsertRowid,
      );
      db.query(
        `INSERT INTO block (message_id, session_id, ordinal, type, text)
         VALUES (?1, ?2, 0, 'text', ?3)`,
      ).run(messageId, sessionId, prompt);
    }
  } finally {
    closeDb(db);
  }
}

const run = (...args: string[]) =>
  runCli(["--db", dbPath, "--no-sync", ...args], { env: { DECANT_NO_SYNC: "1" }, homeDir: home });

async function titles(...args: string[]): Promise<string[]> {
  const result = await run("--json", "ls", ...args);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  return (JSON.parse(result.stdout) as { title: string }[]).map((row) => row.title);
}

const WIDGET_TITLES = [
  "widget root three",
  "widget second checkout",
  "widget external worktree",
  "widget feature worktree needle",
  "widget root two",
  "widget root one needle",
];

/** Run the real entry point from `cwd`, the one thing `runCli` cannot set. */
/** The message of the JSON error object `--json` prints as stderr's last line. */
function jsonError(stderr: string): { code: string; message: string } {
  return JSON.parse(stderr.trim().split("\n").at(-1) ?? "{}").error;
}

function runFrom(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "..", "src", "cli.ts"),
      "--db",
      dbPath,
      "--no-sync",
      ...args,
    ],
    { cwd, env: { ...process.env, DECANT_NO_SYNC: "1", HOME: home, DECANT_DB: undefined } },
  );
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("ls --project", () => {
  const ROOT_ONLY = ["widget root three", "widget root two", "widget root one needle"];

  test("matches the stored path, and leaves the repository's worktrees out", async () => {
    expect(await titles("--project", widget)).toEqual(ROOT_ONLY);
  });

  test("ignores a trailing slash", async () => {
    expect(await titles("--project", `${widget}/`)).toEqual(ROOT_ONLY);
  });

  test("folds dot segments and follows a symlink to the stored directory", async () => {
    expect(await titles("--project", join(widget, "src", ".."))).toEqual(ROOT_ONLY);
    expect(await titles("--project", link)).toEqual(ROOT_ONLY);
  });

  test("expands a leading ~ against the home directory", async () => {
    expect(await titles("--project", "~/work")).toEqual(["home work"]);
  });

  test("resolves . and relative paths against the current directory", () => {
    const db = openDb(dbPath);
    try {
      expect(resolveProjectPath(db, ".", { cwd: widget })).toEqual({ path: widget });
      expect(resolveProjectPath(db, "widget/", { cwd: base })).toEqual({ path: widget });
      expect(resolveProjectPath(db, "../gadget", { cwd: widget })).toEqual({ path: gadget });
      // A stored path that is not on this machine still matches as typed.
      expect(resolveProjectPath(db, external, { cwd: base })).toEqual({ path: external });
    } finally {
      closeDb(db);
    }
    const fromCwd = runFrom(widget, "--json", "ls", "--project", ".");
    expect(fromCwd.code).toBe(0);
    expect((JSON.parse(fromCwd.stdout) as { title: string }[]).map((row) => row.title)).toEqual(
      ROOT_ONLY,
    );
  });

  test("a path the archive has never seen is an error, not an empty list", async () => {
    const missing = join(base, "elsewhere");
    const result = await run("--json", "ls", "--project", missing);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const error = jsonError(result.stderr);
    expect(error.message).toContain(`no project matches --project ${JSON.stringify(missing)}`);
    expect(error.message).toContain("decant project ls");
  });

  test("a known project with nothing in the date range is still an empty list", async () => {
    const result = await run("--json", "ls", "--project", widget, "--since", "2027-01-01");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  test("an empty value is a usage error", async () => {
    const result = await run("ls", "--project", "");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--project needs a path");
  });
});

describe("ls --repo", () => {
  test("covers the root, its worktrees, and another checkout with the same remote", async () => {
    expect(await titles("--repo", widget)).toEqual(WIDGET_TITLES);
  });

  test("accepts a worktree, a subdirectory, a symlink, and a trailing slash", async () => {
    expect(await titles("--repo", feature)).toEqual(WIDGET_TITLES);
    expect(await titles("--repo", external)).toEqual(WIDGET_TITLES);
    expect(await titles("--repo", join(widget, "src"))).toEqual(WIDGET_TITLES);
    expect(await titles("--repo", `${link}/`)).toEqual(WIDGET_TITLES);
  });

  test("finds the repository from a linked worktree with no sessions of its own", async () => {
    expect(await titles("--repo", fresh)).toEqual(WIDGET_TITLES);
  });

  test("accepts . from a checkout, a subdirectory, and a fresh worktree", () => {
    for (const cwd of [widget, join(widget, "src"), fresh]) {
      const result = runFrom(cwd, "--json", "ls", "--repo", ".", "--fields", "title");
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(WIDGET_TITLES.map((title) => ({ title })));
    }
  });

  test("a directory inside a checkout also brings the checkout's own sessions", async () => {
    expect(await titles("--repo", join(local, "pkg"))).toEqual(["local package", "local root"]);
    // The archive files a package directory as its own root, and without a
    // remote nothing ties it back to the checkout around it.
    expect(await titles("--repo", local)).toEqual(["local root"]);
  });

  test("accepts a remote identity and the URL forms that name it", async () => {
    for (const remote of [
      WIDGET_REMOTE,
      "https://example.test/acme/widget.git",
      "git@example.test:acme/widget.git",
    ]) {
      expect(await titles("--repo", remote)).toEqual(WIDGET_TITLES);
    }
  });

  test("accepts a stored key that is not a path", async () => {
    expect(await titles("--repo", "orphan")).toEqual(["orphan worktree"]);
  });

  test("accepts a bare name when it names one repository", async () => {
    // Two roots are named widget, and their shared remote makes them one.
    expect(await titles("--repo", "widget")).toEqual(WIDGET_TITLES);
  });

  test("a name shared by unrelated repositories is a usage error that lists them", async () => {
    const result = await run("--json", "ls", "--repo", "gadget");
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("names several repositories");
    expect(result.stderr).toContain(gadget);
    expect(result.stderr).toContain(otherGadget);
  });

  test("a bare name stays ambiguous when the current directory holds a folder of that name", () => {
    mkdirSync(join(widget, "gadget"), { recursive: true });
    const bare = runFrom(widget, "--json", "ls", "--repo", "gadget");
    expect(bare.code).toBe(2);
    expect(bare.stdout).toBe("");
    expect(bare.stderr).toContain("names several repositories");
    expect(bare.stderr).toContain(otherGadget);
    // Written as a path, the folder still means the checkout around it.
    const path = runFrom(widget, "--json", "ls", "--repo", "./gadget", "--fields", "title");
    expect(path.code).toBe(0);
    expect(JSON.parse(path.stdout)).toEqual(WIDGET_TITLES.map((title) => ({ title })));
  });

  test("a directory outside every known repository is an error, not an empty list", async () => {
    const result = await run("--json", "ls", "--repo", join(base, "elsewhere"));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no repository matches --repo");
  });

  test("does not climb from a missing directory into a parent project", () => {
    const db = openDb(dbPath);
    try {
      const gone = join(home, "work", "removed");
      expect(resolveRepoRoots(db, gone, { cwd: base })).toEqual({ kind: "none", tried: [gone] });
      // The same holds for a directory that exists but is in no working tree.
      mkdirSync(join(home, "work", "notes"), { recursive: true });
      expect(resolveRepoRoots(db, join(home, "work", "notes"), { cwd: base }).kind).toBe("none");
    } finally {
      closeDb(db);
    }
  });

  test("combines with --project", async () => {
    expect(await titles("--repo", widget, "--project", feature)).toEqual([
      "widget feature worktree needle",
    ]);
  });
});

describe("ls --since, --until, and --offset", () => {
  test("both days are inclusive", async () => {
    expect(await titles("--since", "2026-03-09")).toEqual([
      "home work",
      "widget root three",
      "gadget two",
    ]);
    expect(await titles("--until", "2026-03-02")).toEqual([
      "gadget one needle",
      "widget root one needle",
    ]);
    expect(
      await titles("--repo", widget, "--since", "2026-03-06", "--until", "2026-03-08"),
    ).toEqual([
      "widget second checkout",
      "widget external worktree",
      "widget feature worktree needle",
    ]);
  });

  test("--offset pages through a listing", async () => {
    const first = await titles("--repo", widget, "--limit", "4");
    const second = await titles("--repo", widget, "--limit", "4", "--offset", "4");
    expect([...first, ...second]).toEqual(WIDGET_TITLES);
    expect(await titles("--repo", widget, "--offset", "6")).toEqual([]);
  });

  test("a malformed date, a reversed range, and a negative offset are usage errors", async () => {
    for (const value of ["yesterday", "2026-3-1", "2026-02-30", "2026-03-01T00:00:00Z"]) {
      const result = await run("ls", "--since", value);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("expected a date as YYYY-MM-DD");
    }
    const reversed = await run("ls", "--since", "2026-03-09", "--until", "2026-03-01");
    expect(reversed.code).toBe(2);
    expect(reversed.stderr).toContain("--since 2026-03-09 is after --until 2026-03-01");
    const negative = await run("ls", "--offset", "-1");
    expect(negative.code).toBe(2);
    expect(negative.stderr).toContain("expected zero or a positive integer");
  });
});

describe("ls --fields", () => {
  test("the default JSON row keeps every field, and the valid list names them all", async () => {
    const result = await run("--json", "ls", "--limit", "1");
    const [row] = JSON.parse(result.stdout) as Record<string, unknown>[];
    expect(Object.keys(row ?? {}).sort()).toEqual([...SESSION_FIELDS].sort());
    expect(SESSION_FIELDS).toHaveLength(37);
  });

  test("prints only the named fields, in the order given", async () => {
    const result = await run(
      "--json",
      "ls",
      "--repo",
      orphan,
      "--fields",
      "title, id,project_path",
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe(
      `${JSON.stringify([{ title: "orphan worktree", id: 10, project_path: orphan }], null, 2)}\n`,
    );
  });

  test("a four-field listing is a small fraction of the default one", async () => {
    const whole = await run("--json", "ls");
    const narrow = await run("--json", "ls", "--fields", "id,tool,started_at,title");
    const wholeBytes = Buffer.byteLength(whole.stdout);
    const narrowBytes = Buffer.byteLength(narrow.stdout);
    expect((JSON.parse(narrow.stdout) as unknown[]).length).toBe(SESSIONS.length);
    // No field here holds a temp path, so the size is the same on any machine.
    expect(narrowBytes).toBe(1666);
    // The whole listing holds temp paths, so its size varies by machine: about
    // 16,500 bytes on macOS and 14,700 on Linux for the same 13 rows.
    expect(narrowBytes * 5).toBeLessThan(wholeBytes);
  });

  test("without --json the fields print as tab-separated columns", async () => {
    const result = await run("ls", "--repo", "orphan", "--fields", "id,started_at,title,model");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe("10\t2026-03-04T12:00:00.000Z\torphan worktree\t\n");
  });

  test("a tab or a newline inside a list value stays in its cell", () => {
    expect(textCell(["high", "low\tx", "a\nb"])).toBe("high,low x,a b");
    expect(textCell("one\r\ntwo")).toBe("one two");
    expect(textCell(null)).toBe("");
  });

  test("an unknown field is a usage error that lists the valid ones", async () => {
    const result = await run("--json", "ls", "--fields", "id,cost,nope");
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(jsonError(result.stderr)).toMatchObject({ code: "invalid_argument" });
    expect(jsonError(result.stderr).message).toContain('unknown field "cost", "nope"');
    for (const field of SESSION_FIELDS) {
      expect(result.stderr).toContain(field);
    }
    const empty = await run("--json", "ls", "--fields", "");
    expect(empty.code).toBe(2);
  });
});

describe("project ls", () => {
  test("the default JSON row keeps every field, and the valid list names them all", async () => {
    const result = await run("--json", "project", "ls");
    const rows = JSON.parse(result.stdout) as Record<string, unknown>[];
    expect(rows).toHaveLength(10);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([...PROJECT_FIELDS].sort());
  });

  test("--limit and --offset page through the same order", async () => {
    const all = (
      JSON.parse((await run("--json", "project", "ls")).stdout) as { path: string }[]
    ).map((row) => row.path);
    const page = async (...args: string[]): Promise<string[]> =>
      (
        JSON.parse((await run("--json", "project", "ls", ...args)).stdout) as { path: string }[]
      ).map((row) => row.path);
    expect(await page("--limit", "3")).toEqual(all.slice(0, 3));
    expect(await page("--limit", "3", "--offset", "3")).toEqual(all.slice(3, 6));
    expect(await page("--offset", "6")).toEqual(all.slice(6));
    expect(await page("--offset", "10")).toEqual([]);
  });

  test("--fields narrows the JSON and the text output", async () => {
    const whole = await run("--json", "project", "ls");
    const narrow = await run("--json", "project", "ls", "--fields", "path,root_path,sessions");
    const rows = JSON.parse(narrow.stdout) as Record<string, unknown>[];
    expect(rows[0]).toEqual({ path: widget, root_path: widget, sessions: 3 });
    expect(rows.every((row) => Object.keys(row).join() === "path,root_path,sessions")).toBe(true);
    expect(Buffer.byteLength(narrow.stdout) * 2).toBeLessThan(Buffer.byteLength(whole.stdout));

    const text = await run(
      "project",
      "ls",
      "--limit",
      "1",
      "--fields",
      "sessions,path,session_tools",
    );
    expect(text.stdout).toBe(`3\t${widget}\tclaude_code\n`);
  });

  test("an unknown field and a zero limit are usage errors", async () => {
    const field = await run("--json", "project", "ls", "--fields", "path,title");
    expect(field.code).toBe(2);
    expect(jsonError(field.stderr).message).toContain('unknown field "title"');
    expect(field.stderr).toContain("worktree_count");
    const limit = await run("project", "ls", "--limit", "0");
    expect(limit.code).toBe(2);
    // The shared --limit check from parse.ts answers for every command.
    expect(limit.stderr).toContain("expected a positive integer");
  });
});

describe("search scope flags", () => {
  const hits = async (...args: string[]): Promise<string[]> => {
    const result = await run("--json", "search", "needle", ...args);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    return (JSON.parse(result.stdout) as { session_title: string }[])
      .map((row) => row.session_title)
      .sort();
  };

  test("--repo and --project scope the matches", async () => {
    expect(await hits()).toEqual([
      "gadget one needle",
      "widget feature worktree needle",
      "widget root one needle",
    ]);
    expect(await hits("--repo", fresh)).toEqual([
      "widget feature worktree needle",
      "widget root one needle",
    ]);
    expect(await hits("--project", `${widget}/`)).toEqual(["widget root one needle"]);
    expect(await hits("--tool", "codex")).toEqual([]);
  });

  test("--since and --until bound the session start day", async () => {
    expect(await hits("--since", "2026-03-02")).toEqual([
      "gadget one needle",
      "widget feature worktree needle",
    ]);
    expect(await hits("--until", "2026-03-02")).toEqual([
      "gadget one needle",
      "widget root one needle",
    ]);
  });

  test("--offset continues where a shorter read stopped", async () => {
    const all = await hits();
    const first = await hits("--limit", "2");
    const rest = await hits("--limit", "2", "--offset", "2");
    expect([...first, ...rest].sort()).toEqual(all);
    expect(rest).toHaveLength(1);
  });

  test("an unknown repository is an error, and a malformed date a usage error", async () => {
    const repo = await run("--json", "search", "needle", "--repo", join(base, "elsewhere"));
    expect(repo.code).toBe(1);
    expect(repo.stdout).toBe("");
    expect(repo.stderr).toContain("no repository matches --repo");
    const date = await run("search", "needle", "--since", "last week");
    expect(date.code).toBe(2);
  });
});

describe("repository roots in the query layer", () => {
  test("a list of roots matches any of them, and an empty list matches nothing", () => {
    const db = openDb(dbPath);
    try {
      const count = (repo: string | string[]): number =>
        listSessions(db, { repo, limit: 100 }).length;
      expect(count(widget)).toBe(5);
      expect(count([widget, clone])).toBe(6);
      expect(count([])).toBe(0);
      expect(search(db, "needle", 30, { repo: [gadget] })).toHaveLength(1);
      expect(search(db, "needle", 30, { repo: [] })).toHaveLength(0);
    } finally {
      closeDb(db);
    }
  });
});

describe("completion", () => {
  test("offers the list flags", async () => {
    const bash = await runCli(["completion", "bash"]);
    for (const flag of ["--project", "--repo", "--since", "--until", "--offset", "--fields"]) {
      expect(bash.stdout).toContain(flag);
    }
  });
});

describe("repository resolution from stored rows alone", () => {
  type ProjectRow = [
    path: string,
    worktree: 0 | 1,
    root: string,
    source: string,
    remote: string | null,
  ];

  function resolveIn(name: string, rows: ProjectRow[], value: string) {
    const db = openDb(join(base, `${name}.db`));
    try {
      const insert = db.query(
        `INSERT INTO project(path, name, is_worktree, root_path, root_source, repo_remote)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      );
      for (const [path, worktree, root, source, remote] of rows) {
        insert.run(path, path, worktree, root, source, remote);
      }
      return resolveRepoRoots(db, value, { cwd: base });
    } finally {
      closeDb(db);
    }
  }

  test("a bare name matches a root stored with backslashes", () => {
    const root = "C:\\work\\sprocket";
    expect(resolveIn("backslashes", [[root, 0, root, "self", null]], "sprocket")).toEqual({
      kind: "matched",
      roots: [root],
    });
  });

  test("a root with no row of its own takes its identity from a Git-resolved worktree", () => {
    const cog = "/synthetic/cog";
    const rows: ProjectRow[] = [
      ["/synthetic/trees/cog-a", 1, cog, "git", "example.test/acme/cog"],
      ["/synthetic/cog-clone", 0, "/synthetic/cog-clone", "self", "example.test/acme/cog"],
      // Grouped under the root by name only, so its remote says nothing about the root.
      ["/synthetic/trees/cog-b", 1, cog, "namematch", "example.test/other/cog"],
      ["/synthetic/other-cog", 0, "/synthetic/other-cog", "self", "example.test/other/cog"],
    ];
    expect(resolveIn("git-worktree", rows, cog)).toEqual({
      kind: "matched",
      roots: [cog, "/synthetic/cog-clone"],
    });
  });
});

describe.skipIf(process.platform === "win32")("Windows paths stored from another machine", () => {
  const root = "C:\\work\\windows";
  const share = "\\\\server\\share\\repo";

  function resolveBoth(value: string) {
    const db = openDb(join(base, "windows.db"));
    try {
      const insert = db.query(
        `INSERT OR IGNORE INTO project(path, name, is_worktree, root_path, root_source)
         VALUES (?1, ?1, 0, ?1, 'self')`,
      );
      insert.run(root);
      insert.run(share);
      return {
        project: resolveProjectPath(db, value, { cwd: base }),
        repo: resolveRepoRoots(db, value, { cwd: base }),
      };
    } finally {
      closeDb(db);
    }
  }

  test("a trailing backslash or a dot segment still names the stored path", () => {
    for (const value of [root, `${root}\\`, "C:\\work\\.\\windows", "C:\\work\\tmp\\..\\windows"]) {
      expect(resolveBoth(value)).toEqual({
        project: { path: root },
        repo: { kind: "matched", roots: [root] },
      });
    }
    expect(resolveBoth(`${share}\\`).project).toEqual({ path: share });
  });

  test("a miss reports the Windows form it looked for", () => {
    expect(resolveBoth("C:\\work\\other\\").project).toEqual({
      path: null,
      tried: ["C:\\work\\other"],
    });
  });
});

describe("--since and --until across a UTC offset", () => {
  const offsetDb = join(base, "offsets.db");
  // Each start is shown with its UTC day. The offset forms cross midnight.
  const STARTS: [title: string, startedAt: string][] = [
    ["clock west late", "2026-03-01T23:30:00-08:00"], // 2026-03-02
    ["clock west late no colon", "2026-03-01T23:45:00-0800"], // 2026-03-02
    ["clock east early", "2026-03-02T02:00:00+09:00"], // 2026-03-01
    ["clock utc first", "2026-03-01T12:00:00.000Z"], // 2026-03-01
    ["clock utc second", "2026-03-02T12:00:00.000Z"], // 2026-03-02
  ];
  {
    const db = openDb(offsetDb);
    try {
      db.query(
        "INSERT INTO project(id, path, name, is_worktree) VALUES (1, '/synthetic/tz', 'tz', 0)",
      ).run();
      for (const [index, [title, startedAt]] of STARTS.entries()) {
        const sessionId = Number(
          db
            .query(
              `INSERT INTO session(tool, source_session_id, source_path, project_id, title,
                                   started_at, message_count)
               VALUES ('codex', ?1, ?2, 1, ?3, ?4, 1)`,
            )
            .run(`tz-${index}`, `/synthetic/tz/${index}.jsonl`, title, startedAt).lastInsertRowid,
        );
        const messageId = Number(
          db
            .query("INSERT INTO message (session_id, seq, role, raw) VALUES (?1, 0, 'user', '{}')")
            .run(sessionId).lastInsertRowid,
        );
        db.query(
          `INSERT INTO block (message_id, session_id, ordinal, type, text)
           VALUES (?1, ?2, 0, 'text', ?3)`,
        ).run(messageId, sessionId, title);
      }
    } finally {
      closeDb(db);
    }
  }
  const runTz = (...args: string[]) =>
    runCli(["--db", offsetDb, "--no-sync", "--json", ...args], {
      env: { DECANT_NO_SYNC: "1" },
      homeDir: home,
    });
  const named = async (key: "title" | "session_title", ...args: string[]) => {
    const result = await runTz(...args);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    return (JSON.parse(result.stdout) as Record<string, string>[]).map((row) => row[key]).sort();
  };
  const MARCH_1 = ["clock east early", "clock utc first"];
  const MARCH_2 = ["clock utc second", "clock west late", "clock west late no colon"];

  test("ls counts a negative or a positive offset on its UTC day", async () => {
    expect(await named("title", "ls", "--since", "2026-03-02")).toEqual(MARCH_2);
    expect(await named("title", "ls", "--until", "2026-03-01")).toEqual(MARCH_1);
    expect(await named("title", "ls", "--since", "2026-03-01", "--until", "2026-03-01")).toEqual(
      MARCH_1,
    );
  });

  test("the first and last representable days keep every session", async () => {
    // The day after 9999-12-31 is written +010000-01-01, which sorts before
    // every stored timestamp, so a widened bound built from it matched nothing.
    const all = [...MARCH_1, ...MARCH_2].sort();
    expect(await named("title", "ls", "--until", "9999-12-31")).toEqual(all);
    expect(await named("title", "ls", "--since", "0000-01-01")).toEqual(all);
  });

  test("search reads the same days", async () => {
    expect(await named("session_title", "search", "clock", "--since", "2026-03-02")).toEqual(
      MARCH_2,
    );
    expect(await named("session_title", "search", "clock", "--until", "2026-03-01")).toEqual(
      MARCH_1,
    );
  });

  test("callers that do not ask for UTC days keep the stored prefix", () => {
    const db = openDb(offsetDb);
    try {
      const titlesOf = (filter: Parameters<typeof listSessions>[1]) =>
        listSessions(db, filter)
          .map((row) => row.title)
          .sort();
      expect(titlesOf({ from: "2026-03-02" })).toEqual(["clock east early", "clock utc second"]);
      expect(titlesOf({ from: "2026-03-02", utcDays: true })).toEqual(MARCH_2);
    } finally {
      closeDb(db);
    }
  });
});
