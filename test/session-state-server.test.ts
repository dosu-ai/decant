import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { handleRequest } from "../src/server.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-session-state-server-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshConfig(): Config {
  dbCounter += 1;
  const root = join(workDir, `case-${dbCounter}`);
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "codex");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(codexDir, "sessions"), { recursive: true });
  return { dbPath: join(root, "archive.db"), claudeDir, codexDir };
}

function seed(config: Config): void {
  const db = openDb(config.dbPath);
  db.exec(`
    INSERT INTO project(id, path) VALUES (1, '/session-state');
    INSERT INTO session(
      id, tool, source_session_id, project_id, title, started_at,
      is_subagent, parent_session_id, source_path, raw_meta
    ) VALUES
      (1, 'codex', 'state-root', 1, 'State root', '2026-07-29T12:00:00Z', 0, NULL,
       '/synthetic/state-root.jsonl', NULL),
      (2, 'codex', 'state-child', 1, 'State child', '2026-07-29T12:01:00Z', 1, 1,
       '/synthetic/state-child.jsonl',
       '{"parent_thread_id":"state-root","isSubagent":true}');
    INSERT INTO ingest_source(path, tool, session_id, status)
    VALUES
      ('/synthetic/state-root.jsonl', 'codex', 1, 'ok'),
      ('/synthetic/state-child.jsonl', 'codex', 2, 'ok');
    INSERT INTO ingest_issue(source_path, line_no, error, raw_line, code)
    VALUES
      ('/synthetic/state-root.jsonl', 1, 'synthetic parse issue',
       '{"private":"SECRET TRANSCRIPT TEXT"}', 'unparsed_line'),
      ('/synthetic/state-child.jsonl', 2, 'synthetic parse issue',
       '{"private":"CHILD TRANSCRIPT TEXT"}', 'unparsed_line');
  `);
  db.close();
}

async function route(
  config: Config,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await handleRequest(
    new Request(`http://127.0.0.1:3000${path}`, { ...init, headers }),
    config,
  );
  return { status: response.status, body: await response.json() };
}

describe("session state route", () => {
  test("archives, restores, and permanently deletes a session tree", async () => {
    const config = freshConfig();
    seed(config);

    const archived = await route(config, "/api/sessions/1/state", {
      method: "POST",
      body: JSON.stringify({ state: "archived" }),
    });
    expect(archived).toMatchObject({
      status: 200,
      body: {
        ok: true,
        id: 1,
        state: "archived",
        user_state: "archived",
        is_user_archived: true,
      },
    });
    expect(await route(config, "/api/sessions")).toMatchObject({ status: 200, body: [] });
    expect(await route(config, "/api/sessions/1")).toMatchObject({
      status: 200,
      body: {
        summary: {
          id: 1,
          user_state: "archived",
          is_user_archived: true,
        },
      },
    });
    expect(
      await route(config, "/api/sessions?include_archived=true&with_subagents=true"),
    ).toMatchObject({
      status: 200,
      body: [
        {
          id: 1,
          user_state: "archived",
          is_user_archived: true,
          subagents: [expect.objectContaining({ id: 2, is_user_archived: true })],
        },
      ],
    });

    expect(
      await route(config, "/api/sessions/1/state", {
        method: "POST",
        body: JSON.stringify({ state: "visible" }),
      }),
    ).toMatchObject({
      status: 200,
      body: {
        ok: true,
        id: 1,
        state: "visible",
        user_state: null,
        is_user_archived: false,
      },
    });
    expect(await route(config, "/api/sessions")).toMatchObject({
      status: 200,
      body: [expect.objectContaining({ id: 1 })],
    });

    expect(
      await route(config, "/api/sessions/1/state", {
        method: "POST",
        body: JSON.stringify({ state: "deleted" }),
      }),
    ).toMatchObject({
      status: 200,
      body: { ok: true, id: 1, state: "deleted" },
    });
    expect(await route(config, "/api/sessions/1")).toMatchObject({
      status: 404,
      body: { code: "session_not_found" },
    });
    const db = openDb(config.dbPath);
    expect(db.query("SELECT COUNT(*) AS n FROM session").get()).toEqual({ n: 0 });
    expect(
      db
        .query(
          `SELECT source_session_id, state
           FROM session_user_state
           ORDER BY source_session_id`,
        )
        .all(),
    ).toEqual([
      { source_session_id: "state-child", state: "deleted" },
      { source_session_id: "state-root", state: "deleted" },
    ]);
    expect(db.query("SELECT raw_line FROM ingest_issue").all()).toEqual([]);
    expect(
      db.query("SELECT path, session_id, status FROM ingest_source ORDER BY path").all(),
    ).toEqual([
      {
        path: "/synthetic/state-child.jsonl",
        session_id: null,
        status: "skipped_deleted",
      },
      {
        path: "/synthetic/state-root.jsonl",
        session_id: null,
        status: "skipped_deleted",
      },
    ]);
    db.close();
  });

  test("validates IDs, JSON state, not-found sessions, and request origin", async () => {
    const config = freshConfig();
    seed(config);

    expect(
      await route(config, "/api/sessions/abc/state", {
        method: "POST",
        body: JSON.stringify({ state: "archived" }),
      }),
    ).toMatchObject({ status: 400, body: { code: "invalid_session_id" } });
    for (const id of ["0", "9007199254740992"]) {
      expect(
        await route(config, `/api/sessions/${id}/state`, {
          method: "POST",
          body: JSON.stringify({ state: "archived" }),
        }),
      ).toMatchObject({ status: 400, body: { code: "invalid_session_id" } });
    }
    expect(
      await route(config, "/api/sessions/1/state", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ state: "archived" }),
      }),
    ).toMatchObject({ status: 415, body: { code: "unsupported_media_type" } });
    expect(
      await route(config, "/api/sessions/1/state", {
        method: "POST",
        body: "{",
      }),
    ).toMatchObject({ status: 400, body: { code: "malformed_body" } });
    expect(
      await route(config, "/api/sessions/1/state", {
        method: "POST",
        body: "null",
      }),
    ).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    expect(
      await route(config, "/api/sessions/1/state", {
        method: "POST",
        body: JSON.stringify({ state: "hidden" }),
      }),
    ).toMatchObject({
      status: 400,
      body: {
        code: "invalid_request",
        allowed: ["archived", "deleted", "visible"],
      },
    });
    expect(
      await route(config, "/api/sessions/999/state", {
        method: "POST",
        body: JSON.stringify({ state: "archived" }),
      }),
    ).toMatchObject({ status: 404, body: { code: "session_not_found" } });
    expect(
      await route(config, "/api/sessions/1/state", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ state: "archived" }),
      }),
    ).toMatchObject({ status: 403, body: { code: "cross_origin_write" } });
  });

  test("maps an archive write lock to a retryable response", async () => {
    const config = freshConfig();
    seed(config);
    const requestDb = openDb(config.dbPath);
    const lockDb = new Database(config.dbPath);
    try {
      requestDb.exec("PRAGMA busy_timeout = 1");
      lockDb.exec("BEGIN IMMEDIATE");
      const response = await handleRequest(
        new Request("http://127.0.0.1:3000/api/sessions/1/state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: "archived" }),
        }),
        config,
        { db: requestDb },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "archive_locked",
        retryable: true,
      });
    } finally {
      lockDb.exec("ROLLBACK");
      lockDb.close();
      requestDb.close();
    }
  });

  test("rolls state back when its derived recommendation refresh fails", async () => {
    const config = freshConfig();
    seed(config);
    const requestDb = openDb(config.dbPath);
    try {
      requestDb.exec("DROP TABLE recommendation");
      const response = await handleRequest(
        new Request("http://127.0.0.1:3000/api/sessions/1/state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: "archived" }),
        }),
        config,
        { db: requestDb },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: "internal_error" });
      expect(
        requestDb
          .query(
            `SELECT state FROM session_user_state
             WHERE tool = 'codex' AND source_session_id = 'state-root'`,
          )
          .get(),
      ).toBeNull();
      expect(requestDb.query("SELECT id FROM session WHERE id = 1").get()).toEqual({ id: 1 });
    } finally {
      requestDb.close();
    }
  });
});
