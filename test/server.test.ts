import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { upsertSession } from "../src/ingest.ts";
import { regenerate } from "../src/recommendations.ts";
import {
  handleRequest,
  publishServerEvent,
  resolveTrustedPeers,
  serve,
} from "../src/server.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-server-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshConfig(): Config {
  dbCounter += 1;
  const root = join(workDir, `case-${dbCounter}`);
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "codex");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(codexDir, "sessions"), { recursive: true });
  mkdirSync(join(codexDir, "archived_sessions"), { recursive: true });
  return {
    dbPath: join(root, "archive.db"),
    claudeDir,
    codexDir,
  };
}

function fixture(tool: "claude" | "codex", name: string): string {
  return readFileSync(join(import.meta.dir, "..", "fixtures", tool, name), "utf8");
}

function seed(config: Config): void {
  const db = openDb(config.dbPath);
  seedDb(db);
  db.close();
}

function seedDb(db: Database): void {
  upsertSession(
    db,
    parseClaudeSession("sess-claude-sample", fixture("claude", "sample.jsonl")),
    "/x/claude-sample.jsonl",
    1,
    2,
    "sample",
  );
  upsertSession(
    db,
    parseClaudeSession("sess-claude-enriched", fixture("claude", "enriched.jsonl")),
    "/x/claude-enriched.jsonl",
    1,
    2,
    "claude",
  );
  upsertSession(
    db,
    parseCodexSession("sess-codex-enriched", fixture("codex", "enriched.jsonl"), new Map()),
    "/x/codex-enriched.jsonl",
    1,
    2,
    "codex",
  );
  regenerate(db);
}

async function route(
  config: Config,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown; contentType: string | null }> {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const request = new Request(`http://127.0.0.1:3000${path}`, { ...init, headers });
  const response = await handleRequest(request, config);
  const contentType = response.headers.get("content-type");
  const body = contentType?.startsWith("application/json")
    ? await response.json()
    : await response.text();
  return { status: response.status, body, contentType };
}

describe("server routes", () => {
  test("health and shell routes respond without opening the archive", async () => {
    const config = freshConfig();

    const health = await route(config, "/api/health");
    expect(health).toMatchObject({
      status: 200,
      body: { ok: true },
      contentType: "application/json; charset=utf-8",
    });

    const root = await route(config, "/");
    expect(root.status).toBe(200);
    expect(root.contentType).toBe("text/html; charset=utf-8");
    expect(root.body).toContain('<div id="root"></div>');
    expect(root.body).toContain("/src/ui/main.tsx");
  });

  test("app routes fall back to the React shell and config is exposed locally", async () => {
    const config = freshConfig();

    const search = await route(config, "/search");
    expect(search.status).toBe(200);
    expect(search.contentType).toBe("text/html; charset=utf-8");

    const detail = await route(config, "/sessions/123");
    expect(detail.status).toBe(200);
    expect(detail.contentType).toBe("text/html; charset=utf-8");

    const localConfig = await route(config, "/api/config");
    expect(localConfig.status).toBe(200);
    expect(localConfig.body).toMatchObject({
      dbPath: config.dbPath,
      claudeDir: config.claudeDir,
      codexDir: config.codexDir,
    });
  });

  test("events route streams hello and published updates", async () => {
    const config = freshConfig();
    const response = await handleRequest(new Request("http://127.0.0.1:3000/api/events"), config);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

    const reader = response.body?.getReader();
    if (reader == null) {
      throw new Error("missing SSE body");
    }
    const hello = await reader.read();
    expect(new TextDecoder().decode(hello.value)).toContain("event: hello");

    publishServerEvent({ type: "archive_updated", ingested: 2 });
    const update = await reader.read();
    await reader.cancel();
    const frame = new TextDecoder().decode(update.value);
    expect(frame).toContain("event: archive_updated");
    expect(frame).toContain('"ingested":2');
  });

  test("rejects non-loopback API hosts", async () => {
    const config = freshConfig();

    const response = await handleRequest(new Request("http://evil.example/api/config"), config);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden host" });
  });

  test("rejects protected routes from non-loopback peers on broad binds", async () => {
    const config = freshConfig();

    const spoofedHost = await handleRequest(
      new Request("http://127.0.0.1:3000/api/config"),
      config,
      { boundHostname: "0.0.0.0", remoteAddress: "192.168.1.20" },
    );
    expect(spoofedHost.status).toBe(403);
    expect(await spoofedHost.json()).toEqual({ error: "forbidden remote" });

    const loopbackRead = await handleRequest(
      new Request("http://127.0.0.1:3000/api/config"),
      config,
      { boundHostname: "0.0.0.0", remoteAddress: "::ffff:127.0.0.1" },
    );
    expect(loopbackRead.status).toBe(200);

    const trustedDockerPeer = await handleRequest(
      new Request("http://127.0.0.1:3000/api/config"),
      config,
      {
        boundHostname: "0.0.0.0",
        remoteAddress: "172.17.0.1",
        trustedPeers: ["172.16.0.0/12"],
      },
    );
    expect(trustedDockerPeer.status).toBe(200);

    const bareLocalWrite = await handleRequest(
      new Request("http://127.0.0.1:3000/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      config,
      { boundHostname: "0.0.0.0", remoteAddress: "127.0.0.1" },
    );
    expect(bareLocalWrite.status).toBe(403);
    expect(await bareLocalWrite.json()).toEqual({ error: "cross-origin writes are forbidden" });

    const browserLocalWrite = await handleRequest(
      new Request("http://127.0.0.1:3000/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: "{}",
      }),
      config,
      { boundHostname: "0.0.0.0", remoteAddress: "127.0.0.1" },
    );
    expect(browserLocalWrite.status).toBe(200);
  });

  test("resolves trusted peers from env and serve flags as a union", () => {
    expect(resolveTrustedPeers([], "172.16.0.0/12")).toEqual(["172.16.0.0/12"]);
    expect(resolveTrustedPeers(["10.0.0.5"], undefined)).toEqual(["10.0.0.5"]);
    expect(resolveTrustedPeers(["10.0.0.5, 10.0.0.6"], "172.16.0.0/12")).toEqual([
      "172.16.0.0/12",
      "10.0.0.5",
      "10.0.0.6",
    ]);
    expect(resolveTrustedPeers(["172.16.0.0/12"], "172.16.0.0/12")).toEqual(["172.16.0.0/12"]);
  });

  test("rejects cross-origin and non-json mutating requests", async () => {
    const config = freshConfig();

    const crossSite = await handleRequest(
      new Request("http://127.0.0.1:3000/api/launch/agent", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ agent: "claude", prompt: "run this" }),
      }),
      config,
    );
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "cross-origin writes are forbidden" });

    const textPlain = await handleRequest(
      new Request("http://127.0.0.1:3000/api/search", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ query: "auth" }),
      }),
      config,
    );
    expect(textPlain.status).toBe(415);
    expect(await textPlain.json()).toEqual({ error: "content-type must be application/json" });

    const syncWithoutJson = await handleRequest(
      new Request("http://127.0.0.1:3000/api/sync", { method: "POST" }),
      config,
    );
    expect(syncWithoutJson.status).toBe(415);
    expect(await syncWithoutJson.json()).toEqual({
      error: "content-type must be application/json",
    });
  });

  test("settings routes read options and persist sanitized choices", async () => {
    const config = freshConfig();
    const prior = process.env.DECANT_CONFIG_DIR;
    process.env.DECANT_CONFIG_DIR = join(workDir, "server-settings");
    try {
      const settings = await route(config, "/api/settings");
      expect(settings.status).toBe(200);
      expect(settings.body).toMatchObject({
        settings: expect.objectContaining({ agent: "claude" }),
        options: expect.objectContaining({ agents: expect.any(Array) }),
      });

      const saved = await route(config, "/api/settings", {
        method: "POST",
        body: JSON.stringify({ agent: "codex", terminal: "wezterm", ide: "zed", extra: "no" }),
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        saved: true,
        settings: { agent: "codex", terminal: "wezterm", ide: "zed" },
      });
    } finally {
      if (prior == null) {
        delete process.env.DECANT_CONFIG_DIR;
      } else {
        process.env.DECANT_CONFIG_DIR = prior;
      }
    }
  });

  test("lists, gets, and searches sessions", async () => {
    const config = freshConfig();
    seed(config);

    const sessions = await route(config, "/api/sessions?limit=2");
    expect(sessions.status).toBe(200);
    expect(sessions.body).toBeArrayOfSize(2);
    expect(sessions.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: "claude_code" })]),
    );
    const id = (sessions.body as { id: number }[])[0]?.id ?? 0;

    const detail = await route(config, `/api/sessions/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      summary: { id },
      messages: expect.any(Array),
    });

    const search = await route(config, "/api/search", {
      method: "POST",
      body: JSON.stringify({ query: "auth", limit: 5 }),
    });
    expect(search.status).toBe(200);
    expect(search.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: "claude_code" })]),
    );

    const malformed = await route(config, "/api/search", {
      method: "POST",
      body: JSON.stringify({ query: '"' }),
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "invalid search query" });
  });

  test("returns stats, files, tools, and recommendations", async () => {
    const config = freshConfig();
    seed(config);

    const totals = await route(config, "/api/stats/summary");
    expect(totals.status).toBe(200);
    expect(totals.body).toMatchObject({ sessions: 3, tool_calls: expect.any(Number) });

    const scopedTotals = await route(config, "/api/stats/summary?from=2026-05-04&to=2026-05-04");
    expect(scopedTotals.status).toBe(200);
    expect(scopedTotals.body).toMatchObject({ sessions: 1 });

    const scopedSessions = await route(config, "/api/sessions?from=2026-05-04&to=2026-05-04");
    expect(scopedSessions.status).toBe(200);
    expect(scopedSessions.body).toEqual([
      expect.objectContaining({ source_session_id: "sess-codex-enr" }),
    ]);

    const projects = await route(config, "/api/projects");
    expect(projects.status).toBe(200);
    expect(projects.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/Users/dev/proj",
          is_worktree: false,
          session_tools: expect.arrayContaining(["claude_code", "codex"]),
        }),
      ]),
    );

    const byTool = await route(config, "/api/stats/by-dimension?dim=tool");
    expect(byTool.status).toBe(200);
    expect(byTool.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "claude_code" }),
        expect.objectContaining({ key: "codex" }),
      ]),
    );

    const files = await route(config, "/api/files?group=ext&op=edit");
    expect(files.status).toBe(200);
    expect(files.body).toEqual(expect.arrayContaining([expect.objectContaining({ key: "rs" })]));

    const tools = await route(config, "/api/tools/usage?limit=3");
    expect(tools.status).toBe(200);
    expect(tools.body).toBeArray();

    const recommendations = await route(config, "/api/recommendations?status=all");
    expect(recommendations.status).toBe(200);
    expect(recommendations.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "catalog:agents-md" })]),
    );

    const db = openDb(config.dbPath);
    db.query("UPDATE recommendation SET score = 12345 WHERE key = 'catalog:agents-md'").run();
    db.close();
    const reread = await route(config, "/api/recommendations?status=all");
    expect(reread.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "catalog:agents-md", score: 12345 })]),
    );
  });

  test("returns metadata and extended analytics routes", async () => {
    const config = freshConfig();
    seed(config);

    const activity = await route(config, "/api/analytics/activity");
    expect(activity.status).toBe(200);
    const activityBody = activity.body as {
      by_hour: unknown[];
      by_weekday: unknown[];
      timezone: string;
    };
    expect(Array.isArray(activityBody.by_hour)).toBe(true);
    expect(Array.isArray(activityBody.by_weekday)).toBe(true);
    expect(activityBody.by_hour).toHaveLength(24);
    expect(activityBody.by_weekday).toHaveLength(7);
    expect(activityBody.timezone).toStartWith("UTC");

    const sparks = await route(config, "/api/analytics/model-sparklines");
    expect(sparks.status).toBe(200);
    expect(sparks.body).toMatchObject({ days: expect.any(Array), models: expect.any(Object) });

    const economics = await route(config, "/api/analytics/token-economics");
    expect(economics.status).toBe(200);
    expect(economics.body).toMatchObject({
      buckets: expect.arrayContaining([expect.objectContaining({ bucket: "context" })]),
      totals: expect.objectContaining({ estimated_cost_usd: expect.any(Number) }),
    });

    const sessions = await route(config, "/api/sessions?limit=1");
    const sessionId = (sessions.body as { id: number }[])[0]?.id;
    const sessionEconomics = await route(config, `/api/sessions/${sessionId}/token-economics`);
    expect(sessionEconomics.status).toBe(200);
    expect(sessionEconomics.body).toMatchObject({
      buckets: expect.arrayContaining([expect.objectContaining({ bucket: "context" })]),
      totals: expect.objectContaining({ estimated_cost_usd: expect.any(Number) }),
    });

    const now = await route(config, "/api/analytics/now");
    expect(now.status).toBe(200);
    expect(now.body).toMatchObject({
      today: expect.objectContaining({ sessions: expect.any(Number) }),
      active_sessions: [],
      sync_in_progress: false,
    });

    const bounds = await route(config, "/api/date-bounds");
    expect(bounds.status).toBe(200);
    expect(bounds.body).toMatchObject({ min: "2026-05-01", max: "2026-05-04" });
  });

  test("mark recommendation updates status", async () => {
    const config = freshConfig();
    seed(config);

    const marked = await route(config, "/api/recommendations/mark", {
      method: "POST",
      body: JSON.stringify({ key: "catalog:agents-md", source: "test", note: "done" }),
    });
    expect(marked.status).toBe(200);
    expect(marked.body).toMatchObject({
      ok: true,
      key: "catalog:agents-md",
      status: "implemented",
    });

    const implemented = await route(config, "/api/recommendations?status=implemented");
    expect(implemented.body).toEqual([
      expect.objectContaining({ key: "catalog:agents-md", note: "done" }),
    ]);
  });

  test("validates bad route input", async () => {
    const config = freshConfig();
    seed(config);

    expect((await route(config, "/api/sessions/999999")).status).toBe(404);
    expect((await route(config, "/api/search", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await route(config, "/api/stats/by-dimension?dim=nope")).status).toBe(400);
    expect((await route(config, "/api/files?group=path&op=rename")).status).toBe(400);
    expect((await route(config, "/api/recommendations?status=maybe")).status).toBe(400);
    expect((await route(config, "/missing")).status).toBe(404);
  });

  test("sync route ingests configured source directories", async () => {
    const config = freshConfig();

    const result = await route(config, "/api/sync", { method: "POST", body: "{}" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      scanned: 0,
      ingested: 0,
      failed: 0,
      cancelled: false,
    });

    const status = await route(config, "/api/sync-status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      in_progress: false,
      ingested_count: 0,
      last_error: null,
    });
  });

  test("stop() resolves promptly even while a request awaits an in-flight economics rebuild", async () => {
    const config = freshConfig();
    const gate = Promise.withResolvers<void>();
    let sawAbort = false;
    const server = serve({
      config,
      port: 0,
      economicsComputeVectors: (_path, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted"));
          });
          // Never resolves on its own; only the abort (from server.stop()'s
          // dispose) or the test's gate settles this.
          gate.promise.then(() => reject(new Error("test cleanup")));
        }),
    });

    // Start a real request that will hang awaiting the gated rebuild — this
    // reproduces the exact scenario where naive ordering (disposing the
    // economics cache only *after* awaiting Bun's native stop()) deadlocks:
    // native stop() waits for this in-flight handler, which waits for the
    // rebuild, which is never told to abort until stop() already returned.
    const pendingRequest = fetch(
      `http://127.0.0.1:${server.port}/api/analytics/token-economics`,
    ).catch((error: unknown) => error);
    // Let the connection actually get accepted and the handler reach its
    // await on the rebuild; racing stop() immediately after fetch() can
    // force-close the connection before the server ever processes it, which
    // would make this test pass regardless of the dispose ordering.
    await Bun.sleep(50);

    const t0 = performance.now();
    await Promise.race([
      server.stop(true),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("server.stop() did not resolve within 2s")), 2000),
      ),
    ]);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(sawAbort).toBe(true);

    gate.resolve();
    await pendingRequest.catch(() => {});
  });
});
