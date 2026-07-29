import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { upsertSession } from "../src/ingest.ts";
import { regenerate } from "../src/recommendations.ts";
import {
  handleRequest,
  resolveTrustedPeers,
  serve,
  type TrustedPeerSources,
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
): Promise<{
  status: number;
  body: unknown;
  contentType: string | null;
  headers: Headers;
}> {
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
  return { status: response.status, body, contentType, headers: response.headers };
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
    expect(root.body).toContain('rel="icon" href="/favicon.ico"');
    expect(root.body).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(root.body).toContain('name="description"');
    for (const path of ["/reports/analytics", "/reports/session/42"]) {
      const reportShell = await route(config, path);
      expect(reportShell.status).toBe(200);
      expect(reportShell.contentType).toBe("text/html; charset=utf-8");
      expect(reportShell.body).toContain('<div id="root"></div>');
    }
    const sourceHead = readFileSync(
      join(import.meta.dir, "..", "src", "ui", "index.html"),
      "utf8",
    ).match(/<head>([\s\S]*?)<\/head>/)?.[1];
    expect(sourceHead).toContain('href="./assets/favicon.ico"');
    expect(sourceHead).toContain('href="./assets/apple-touch-icon.png"');
    expect(sourceHead).toContain("Local-first analytics for Claude Code and Codex sessions.");

    const favicon = await route(config, "/favicon.ico");
    expect(favicon.status).toBe(200);
    expect(favicon.contentType).toBe("image/x-icon");
    expect(typeof favicon.body).toBe("string");

    const touchIcon = await route(config, "/apple-touch-icon.png");
    expect(touchIcon.status).toBe(200);
    expect(touchIcon.contentType).toBe("image/png");
  });

  test("app routes fall back to the React shell and config is exposed locally", async () => {
    const config = freshConfig();

    const search = await route(config, "/search");
    expect(search.status).toBe(200);
    expect(search.contentType).toBe("text/html; charset=utf-8");

    const detail = await route(config, "/sessions/123");
    expect(detail.status).toBe(200);
    expect(detail.contentType).toBe("text/html; charset=utf-8");

    const unknownView = await route(config, "/no-page-here");
    expect(unknownView.status).toBe(200);
    expect(unknownView.contentType).toBe("text/html; charset=utf-8");

    const localConfig = await route(config, "/api/config");
    expect(localConfig.status).toBe(200);
    expect(localConfig.body).toMatchObject({
      dbPath: config.dbPath,
      claudeDir: config.claudeDir,
      codexDir: config.codexDir,
    });
  });

  test("the HTML shell built by handleRequest denies framing", async () => {
    const config = freshConfig();

    const response = await handleRequest(new Request("http://127.0.0.1:3000/insights"), config);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  test("events route streams sync worker progress", async () => {
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

    const sync = route(config, "/api/sync", { method: "POST", body: "{}" });
    const update = await reader.read();
    await sync;
    await reader.cancel();
    const frame = new TextDecoder().decode(update.value);
    expect(frame).toContain("event: sync_progress");
    expect(frame).toContain('"scanned":0');
    expect(frame).toContain('"total":0');
  });

  test("rejects non-loopback API hosts", async () => {
    const config = freshConfig();

    const response = await handleRequest(new Request("http://evil.example/api/config"), config);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden host", code: "forbidden_host" });
  });

  test("rejects protected routes from non-loopback peers on broad binds", async () => {
    const config = freshConfig();

    const spoofedHost = await handleRequest(
      new Request("http://127.0.0.1:3000/api/config"),
      config,
      { boundHostname: "0.0.0.0", remoteAddress: "192.168.1.20" },
    );
    expect(spoofedHost.status).toBe(403);
    expect(await spoofedHost.json()).toEqual({
      error: "forbidden remote",
      code: "forbidden_remote",
    });

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
    expect(await bareLocalWrite.json()).toEqual({
      error: "cross-origin writes are forbidden",
      code: "cross_origin_write",
    });

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
    expect(await crossSite.json()).toEqual({
      error: "cross-origin writes are forbidden",
      code: "cross_origin_write",
    });

    const textPlain = await handleRequest(
      new Request("http://127.0.0.1:3000/api/search", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ query: "auth" }),
      }),
      config,
    );
    expect(textPlain.status).toBe(415);
    expect(await textPlain.json()).toEqual({
      error: "content-type must be application/json",
      code: "unsupported_media_type",
    });

    const syncWithoutJson = await handleRequest(
      new Request("http://127.0.0.1:3000/api/sync", { method: "POST" }),
      config,
    );
    expect(syncWithoutJson.status).toBe(415);
    expect(await syncWithoutJson.json()).toEqual({
      error: "content-type must be application/json",
      code: "unsupported_media_type",
    });

    const malformed = await route(config, "/api/search", {
      method: "POST",
      body: "{",
    });
    expect(malformed).toMatchObject({
      status: 400,
      body: {
        error: "request body must be valid JSON",
        code: "malformed_body",
      },
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
        options: expect.objectContaining({
          agents: expect.any(Array),
        }),
      });
      const settingsBody = settings.body as {
        settings: Record<string, unknown>;
        options: Record<string, unknown>;
      };
      expect(settingsBody.settings).not.toHaveProperty("dosuSuggestions");
      expect(settingsBody.options).not.toHaveProperty("dosuSuggestions");

      const saved = await route(config, "/api/settings", {
        method: "POST",
        body: JSON.stringify({
          agent: "codex",
          terminal: "wezterm",
          ide: "zed",
          // Older clients may still send this removed preference.
          dosuSuggestions: "hide",
          extra: "no",
        }),
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        saved: true,
        settings: {
          agent: "codex",
          terminal: "wezterm",
          ide: "zed",
        },
      });
      const savedBody = saved.body as { settings: Record<string, unknown> };
      expect(savedBody.settings).not.toHaveProperty("dosuSuggestions");
    } finally {
      if (prior == null) {
        delete process.env.DECANT_CONFIG_DIR;
      } else {
        process.env.DECANT_CONFIG_DIR = prior;
      }
    }
  });

  test("legacy Dosu settings cannot hide report CTAs", async () => {
    const config = freshConfig();
    seed(config);
    const prior = process.env.DECANT_CONFIG_DIR;
    const configDir = join(workDir, "legacy-dosu-report-settings");
    process.env.DECANT_CONFIG_DIR = configDir;
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "settings.json"),
      `${JSON.stringify({ dosuSuggestions: "hide" }, null, 2)}\n`,
    );
    try {
      const analyticsReport = await route(config, "/api/reports/analytics.html");
      expect(analyticsReport.status).toBe(200);
      expect(analyticsReport.body).toContain("utm_content=report_cta");

      const sessionId = ((await route(config, "/api/sessions?limit=1")).body as { id: number }[])[0]
        ?.id;
      expect(sessionId).toBeNumber();
      const sessionReport = await route(config, `/api/reports/session/${sessionId}.html`);
      expect(sessionReport.status).toBe(200);
      expect(sessionReport.body).toContain("utm_content=report_cta");
    } finally {
      if (prior == null) {
        delete process.env.DECANT_CONFIG_DIR;
      } else {
        process.env.DECANT_CONFIG_DIR = prior;
      }
    }
  });

  test("returns a copyable command when terminal launch is unsupported", async () => {
    const config = freshConfig();
    const response = await handleRequest(
      new Request("http://127.0.0.1:3000/api/launch/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", prompt: "review this session" }),
      }),
      config,
      { launchPlatform: "linux" },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Opening a terminal is only supported on macOS right now.",
      code: "launch_unsupported_platform",
      ok: false,
      command: expect.stringContaining("codex"),
    });
  });

  test("lists, gets, and searches sessions", async () => {
    const config = freshConfig();
    seed(config);

    const sessions = await route(config, "/api/sessions?limit=2");
    expect(sessions.status).toBe(200);
    expect(sessions.body).toBeArrayOfSize(2);
    expect(sessions.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "claude_code" }),
        expect.objectContaining({
          tool: "codex",
          reasoning_effort: "high",
          reasoning_effort_levels: ["high"],
        }),
      ]),
    );
    const id = (sessions.body as { id: number }[])[0]?.id ?? 0;

    const detail = await route(config, `/api/sessions/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      summary: {
        id,
        reasoning_effort: expect.any(String),
        reasoning_effort_levels: expect.any(Array),
      },
      messages: expect.any(Array),
    });
    const firstMessagePage = await route(
      config,
      `/api/sessions/${id}?message_limit=2&message_offset=0`,
    );
    expect(firstMessagePage.body).toMatchObject({
      messages: [{ seq: 0 }, { seq: 1 }],
      message_offset: 0,
      message_limit: 2,
      has_more_messages: true,
    });
    const messageCount = (detail.body as { summary: { message_count: number } }).summary
      .message_count;
    const lastMessagePage = await route(
      config,
      `/api/sessions/${id}?message_limit=2&message_offset=${Math.max(0, messageCount - 1)}`,
    );
    expect(lastMessagePage.body).toMatchObject({
      messages: expect.any(Array),
      message_offset: Math.max(0, messageCount - 1),
      message_limit: 2,
      has_more_messages: false,
    });
    // Backward paging: the client holds a window starting at offset 2 and asks
    // for the gap in front of it. The two pages must abut exactly -- an overlap
    // would duplicate rows, a hole would make messages unreachable by keyboard.
    const laterWindow = await route(config, `/api/sessions/${id}?message_limit=2&message_offset=2`);
    const earlierGap = await route(config, `/api/sessions/${id}?message_limit=2&message_offset=0`);
    const seqOf = (result: { body: unknown }) =>
      (result.body as { messages: { seq: number }[] }).messages.map((message) => message.seq);
    expect(seqOf(laterWindow).length).toBeGreaterThan(0);
    expect(seqOf(earlierGap).length).toBeGreaterThan(0);
    const stitched = [...seqOf(earlierGap), ...seqOf(laterWindow)];
    expect(new Set(stitched).size).toBe(stitched.length);
    expect(stitched).toEqual([...stitched].sort((a, b) => a - b));
    expect(stitched).toEqual([0, 1, 2, 3]);

    const outline = await route(config, `/api/sessions/${id}/outline`);
    expect(outline.status).toBe(200);
    expect(outline.body).toEqual([
      expect.objectContaining({ seq: expect.any(Number), text: expect.any(String) }),
    ]);
    expect(await route(config, "/api/sessions/999999/outline")).toMatchObject({
      status: 404,
      body: { code: "session_not_found", archive_empty: false },
    });

    const search = await route(config, "/api/search", {
      method: "POST",
      body: JSON.stringify({ query: "auth", limit: 5 }),
    });
    expect(search.status).toBe(200);
    expect(search.body).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({
          tool: "claude_code",
          message_seq: expect.any(Number),
          href: expect.stringMatching(/^\/sessions\/\d+#message-\d+$/),
        }),
      ]),
      total: expect.any(Number),
      total_is_capped: false,
      elapsed_ms: expect.any(Number),
    });
    const firstSearchPage = await route(config, "/api/search", {
      method: "POST",
      body: JSON.stringify({ query: "auth", limit: 1 }),
    });
    const secondSearchPage = await route(config, "/api/search", {
      method: "POST",
      body: JSON.stringify({ query: "auth", limit: 1, offset: 1 }),
    });
    const firstPageBody = firstSearchPage.body as {
      results: { block_id: number }[];
      total: number;
    };
    const secondPageBody = secondSearchPage.body as {
      results: { block_id: number }[];
      total: number;
    };
    expect(firstPageBody.results).toHaveLength(1);
    expect(secondPageBody.results).toHaveLength(1);
    expect(secondPageBody.total).toBe(firstPageBody.total);
    expect(secondPageBody.results[0]?.block_id).not.toBe(firstPageBody.results[0]?.block_id);

    const scopedSearch = await route(config, "/api/search", {
      method: "POST",
      body: JSON.stringify({
        query: "auth",
        project: "/not/a/project",
        from: "2026-05-01",
        to: "2026-05-31",
      }),
    });
    expect(scopedSearch).toMatchObject({
      status: 200,
      body: { results: [], total: 0, elapsed_ms: expect.any(Number) },
    });

    const malformed = await route(config, "/api/search", {
      method: "POST",
      body: JSON.stringify({ query: '"' }),
    });
    expect(malformed).toMatchObject({
      status: 200,
      body: { results: [], total: 0, elapsed_ms: expect.any(Number) },
    });
  });

  test("serves per-session context-window timelines", async () => {
    const config = freshConfig();
    seed(config);

    const sessions = await route(config, "/api/sessions?tool=claude_code&limit=10");
    const id =
      (sessions.body as { id: number; source_session_id: string }[]).find(
        (session) => session.source_session_id === "sess-claude-enriched",
      )?.id ?? 0;

    const timeline = await route(config, `/api/sessions/${id}/context-window`);
    expect(timeline.status).toBe(200);
    expect(timeline.body).toMatchObject({
      session_id: id,
      tool: "claude_code",
      window_tokens: 1_000_000,
      window_inferred: true,
      peak_tokens: 1200,
      points: [
        expect.objectContaining({ seq: 1, context_tokens: 1000 }),
        expect.objectContaining({ seq: 3, context_tokens: 1200 }),
      ],
      compactions: [
        expect.objectContaining({ seq: 7, trigger: null, pre_tokens: 1200, post_tokens: null }),
      ],
    });

    expect(await route(config, "/api/sessions/999999/context-window")).toMatchObject({
      status: 404,
      body: { code: "session_not_found", archive_empty: false },
    });
  });

  test("serves per-session ingest issues", async () => {
    const config = freshConfig();
    seed(config);
    const db = openDb(config.dbPath);
    db.query(
      `INSERT INTO ingest_issue (source_path, line_no, error, raw_line, code, created_at)
       VALUES ('/x/claude-sample.jsonl', 99, 'not json', 'not json', 'unparsed_line', datetime('now'))`,
    ).run();
    db.close();

    const sessions = await route(config, "/api/sessions?tool=claude_code&limit=10");
    const id =
      (sessions.body as { id: number; source_session_id: string }[]).find(
        (session) => session.source_session_id === "sess-claude-sample",
      )?.id ?? 0;

    const issues = await route(config, `/api/sessions/${id}/issues`);
    expect(issues.status).toBe(200);
    expect(issues.body).toEqual([
      expect.objectContaining({ code: "unparsed_line", line_no: 99, error: "not json" }),
    ]);
    expect(await route(config, "/api/sessions/999999/issues")).toMatchObject({
      status: 404,
      body: { code: "session_not_found", archive_empty: false },
    });
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

    const calls = await route(
      config,
      "/api/tools/calls?tool=Read&project=%2FUsers%2Fdev%2Fproj&from=2026-05-01&to=2026-05-01&min_ms=1000&limit=1000&offset=0",
    );
    expect(calls).toMatchObject({
      status: 200,
      body: {
        calls: [
          {
            session_id: expect.any(Number),
            session_title: "Fix the failing auth test",
            project: "/Users/dev/proj",
            tool_name: "Read",
            tool_kind: "builtin",
            mcp_server: null,
            input_preview: expect.stringContaining("auth_test.py"),
            input_bytes: expect.any(Number),
            output_preview: expect.any(String),
            output_bytes: expect.any(Number),
            is_error: false,
            has_result: true,
            duration_ms: 1000,
            timestamp: "2026-05-01T10:00:05.000Z",
            seq: expect.any(Number),
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
        summary: {
          calls: 1,
          errors: 0,
          p50_ms: 1000,
          p95_ms: 1000,
        },
      },
    });

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

    const analyticsReport = await route(
      config,
      "/api/reports/analytics.html?from=2026-05-01&to=2026-05-05",
    );
    expect(analyticsReport.status).toBe(200);
    expect(analyticsReport.contentType).toBe("text/html; charset=utf-8");
    expect(analyticsReport.body).toContain("<!doctype html>");
    expect(analyticsReport.body).toContain("Agent activity report");
    expect(analyticsReport.body).toContain(">Optimized<");
    expect(analyticsReport.headers.get("content-disposition")).toBe(
      'attachment; filename="decant-analytics-report.html"',
    );
    expect(analyticsReport.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'none'",
    );

    const sessionId = ((await route(config, "/api/sessions?limit=1")).body as { id: number }[])[0]
      ?.id;
    expect(sessionId).toBeNumber();
    const sessionReport = await route(config, `/api/reports/session/${sessionId}.html`);
    expect(sessionReport.status).toBe(200);
    expect(sessionReport.contentType).toBe("text/html; charset=utf-8");
    expect(sessionReport.body).toContain("Session analysis");
    expect(sessionReport.body).not.toContain("<script");
    expect(sessionReport.headers.get("content-disposition")).toMatch(
      /^attachment; filename="decant-session-\d+-[^"]+\.html"$/,
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
    expect(await route(config, "/api/sessions/999999/token-economics")).toMatchObject({
      status: 404,
      body: { code: "session_not_found", archive_empty: false },
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

    expect(await route(config, "/api/sessions/999999")).toMatchObject({
      status: 404,
      body: {
        error: "session not found",
        code: "session_not_found",
        archive_empty: false,
      },
    });
    expect(await route(config, "/api/reports/session/999999.html")).toMatchObject({
      status: 404,
      body: {
        error: "session not found",
        code: "session_not_found",
        archive_empty: false,
      },
    });
    expect(await route(config, "/api/sessions/abc")).toMatchObject({
      status: 400,
      body: { error: "invalid session id", code: "invalid_session_id" },
    });
    expect(await route(config, "/api/reports/session/abc.html")).toMatchObject({
      status: 400,
      body: { error: "invalid session id", code: "invalid_session_id" },
    });
    expect(await route(config, "/api/sessions/0/outline")).toMatchObject({
      status: 400,
      body: { error: "invalid session id", code: "invalid_session_id" },
    });
    expect(await route(config, "/api/search", { method: "POST", body: "{}" })).toMatchObject({
      status: 400,
      body: { error: "query is required", code: "query_required" },
    });
    expect(await route(config, "/api/stats/by-dimension?dim=nope")).toMatchObject({
      status: 400,
      body: {
        error: "unknown dimension",
        code: "unknown_dimension",
        allowed: ["tool", "model", "project", "day"],
      },
    });
    expect(await route(config, "/api/tools/calls?session=abc")).toMatchObject({
      status: 400,
      body: {
        error: "session must be a positive integer",
        code: "invalid_request",
      },
    });
    expect(await route(config, "/api/tools/calls?min_ms=-1")).toMatchObject({
      status: 400,
      body: {
        error: "min_ms must be a non-negative integer",
        code: "invalid_request",
      },
    });
    expect(await route(config, "/api/tools/calls?errors_only=yes")).toMatchObject({
      status: 400,
      body: {
        error: "errors_only must be true or false",
        code: "invalid_request",
      },
    });
    expect(await route(config, "/api/files?group=path&op=rename")).toMatchObject({
      status: 400,
      body: { error: "invalid files query", code: "invalid_files_query" },
    });
    expect(await route(config, "/api/recommendations?status=maybe")).toMatchObject({
      status: 400,
      body: { error: "unknown status", code: "unknown_status" },
    });
    expect(await route(config, "/api/missing")).toMatchObject({
      status: 404,
      body: { error: "not found", code: "not_found" },
    });
  });

  test("distinguishes an empty archive from a stale session link", async () => {
    const config = freshConfig();
    expect(await route(config, "/api/sessions/42")).toMatchObject({
      status: 404,
      body: {
        error: "session not found",
        code: "session_not_found",
        archive_empty: true,
      },
    });
  });

  test("maps unsupported archive schema versions to actionable conflicts", async () => {
    for (const [version, code, message] of [
      [999, "schema_too_new", "is newer than this build supports"],
      [7, "schema_too_old", "predates this build's baseline"],
    ] as const) {
      const config = freshConfig();
      const db = new Database(config.dbPath, { create: true });
      db.exec(
        `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
         INSERT INTO schema_migrations (version, applied_at) VALUES (${version}, datetime('now'));`,
      );
      db.close();

      const response = await route(config, "/api/sessions");
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code });
      expect((response.body as { error: string }).error).toContain(message);
    }
  });

  test("maps schema drift to an actionable conflict", async () => {
    const config = freshConfig();
    const db = openDb(config.dbPath);
    db.exec("ALTER TABLE recommendation DROP COLUMN impact_label");
    db.close();

    const response = await route(config, "/api/sessions");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "schema_drift" });
    expect((response.body as { error: string }).error).toContain(
      "missing columns: recommendation.impact_label",
    );
    expect((response.body as { error: string }).error).toContain(
      "Back up or move the archive aside",
    );
  });

  test("keeps unexpected exception details in server logs, not 500 responses", async () => {
    const config = freshConfig();
    const closedDb = openDb(config.dbPath);
    closedDb.close();

    const response = await handleRequest(
      new Request("http://127.0.0.1:3000/api/sessions"),
      config,
      { db: closedDb },
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as { code: string; error: string };
    expect(body).toEqual({
      code: "internal_error",
      error: "Decant could not complete this request.",
    });
    expect(body.error.toLowerCase()).not.toContain("closed");
  });

  test("maps a busy archive to a retryable service response", async () => {
    const config = freshConfig();
    seed(config);
    const requestDb = openDb(config.dbPath);
    const lockDb = openDb(config.dbPath);
    try {
      requestDb.exec("PRAGMA busy_timeout = 1");
      const warm = await handleRequest(
        new Request("http://127.0.0.1:3000/api/recommendations?status=all"),
        config,
        { db: requestDb },
      );
      expect(warm.status).toBe(200);

      lockDb.exec("BEGIN IMMEDIATE");
      const response = await handleRequest(
        new Request("http://127.0.0.1:3000/api/recommendations/mark", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "catalog:agents-md" }),
        }),
        config,
        { db: requestDb },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "archive_locked",
        error: "Session logs are temporarily busy. Please try again.",
        retryable: true,
      });
    } finally {
      try {
        lockDb.exec("ROLLBACK");
      } catch {
        // The assertion can fail before the transaction starts.
      }
      lockDb.close();
      requestDb.close();
    }
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

  test("creates the archive directory owner-only from both entry points", async () => {
    const base = freshConfig();
    const routed = { ...base, dbPath: join(dirname(base.dbPath), "routed", "decant.db") };

    expect((await route(routed, "/api/sessions")).status).toBe(200);
    expect(statSync(dirname(routed.dbPath)).mode & 0o7777).toBe(0o700);
    expect(statSync(routed.dbPath).mode & 0o7777).toBe(0o600);

    const served = { ...base, dbPath: join(dirname(base.dbPath), "served", "decant.db") };
    const server = serve({ config: served, port: 0 });
    try {
      expect(statSync(dirname(served.dbPath)).mode & 0o7777).toBe(0o700);
      expect(statSync(served.dbPath).mode & 0o7777).toBe(0o600);
    } finally {
      await server.stop(true);
    }
  });

  test("checks the listening port before opening the archive or starting a watcher", async () => {
    const occupied = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      reusePort: false,
      fetch: () => new Response("occupied"),
    });
    const base = freshConfig();
    const config = {
      ...base,
      dbPath: join(dirname(base.dbPath), "must-not-exist", "archive.db"),
    };
    let watcherEvents = 0;
    try {
      expect(() =>
        serve({
          config,
          port: occupied.port,
          watch: {
            onEvent: () => {
              watcherEvents += 1;
            },
          },
        }),
      ).toThrow(/address already in use|EADDRINUSE|port.*in use/i);
      expect(existsSync(dirname(config.dbPath))).toBe(false);
      expect(watcherEvents).toBe(0);
    } finally {
      await occupied.stop(true);
    }
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

  test("stop() cancels and awaits a manual sync when no watcher is configured", async () => {
    const config = freshConfig();
    const entered = Promise.withResolvers<void>();
    let sawCancellation = false;
    const server = serve({
      config,
      port: 0,
      syncRunner: async (_config, cancel) => {
        entered.resolve();
        while (cancel?.aborted !== true) {
          await Bun.sleep(1);
        }
        sawCancellation = true;
        return {
          scanned: 0,
          ingested: 0,
          skipped: 0,
          issues: 0,
          issuesByCode: {},
          failed: 0,
          cancelled: true,
        };
      },
    });
    const pendingRequest = fetch(`http://127.0.0.1:${server.port}/api/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch((error: unknown) => error);
    await entered.promise;

    await server.stop(true);

    expect(sawCancellation).toBe(true);
    await pendingRequest;
  });
});

describe("trusted peer resolution", () => {
  // Addresses appear the way `/proc/net/route` prints them: the little-endian
  // reading of the network-byte-order word, so 172.17.0.1 is "010011AC".
  const DEFAULT_ROUTE = "00000000";
  const UP = "0001";
  const UP_GATEWAY = "0003";
  const MASK_16 = "0000FFFF";
  const MASK_24 = "00FFFFFF";

  function routeRow(
    iface: string,
    destination: string,
    gateway: string,
    flags: string,
    mask: string,
  ): string {
    return [iface, destination, gateway, flags, "0", "0", "0", mask, "0", "0", "0"].join("\t");
  }

  interface FakeInterface {
    ifindex: number;
    /** Defaults to a peer index that exists in no other namespace entry, which
     * is what a container-side veth looks like. */
    iflink?: number;
    devtype?: string;
    /** A backing bus device, so a real NIC in the host's own namespace. */
    physical?: boolean;
    /** Stacked on this parent in the same namespace (vlan and friends). */
    lowerOf?: string;
  }

  let netCounter = 0;
  function namespace(
    routes: string[],
    interfaces: Record<string, FakeInterface>,
  ): TrustedPeerSources {
    netCounter += 1;
    const root = join(workDir, `net-${netCounter}`);
    const sysClassNetPath = join(root, "sys", "class", "net");
    mkdirSync(sysClassNetPath, { recursive: true });
    const routeTablePath = join(root, "route");
    writeFileSync(
      routeTablePath,
      [
        "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
        ...routes,
        "",
      ].join("\n"),
    );
    for (const [name, iface] of Object.entries(interfaces)) {
      const dir = join(sysClassNetPath, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "ifindex"), `${iface.ifindex}\n`);
      writeFileSync(join(dir, "iflink"), `${iface.iflink ?? 900 + iface.ifindex}\n`);
      writeFileSync(
        join(dir, "uevent"),
        `${iface.devtype == null ? "" : `DEVTYPE=${iface.devtype}\n`}INTERFACE=${name}\n`,
      );
      if (iface.physical === true) {
        writeFileSync(join(dir, "device"), "");
      }
      if (iface.lowerOf != null) {
        writeFileSync(join(dir, `lower_${iface.lowerOf}`), "");
      }
    }
    return { routeTablePath, sysClassNetPath };
  }

  const loopback: FakeInterface = { ifindex: 1, iflink: 1 };
  const optIn = { DECANT_TRUST_DEFAULT_GATEWAY: "1" };

  /** A container on the default Docker bridge: default route via 172.17.0.1
   * over a veth, plus the on-link 172.17.0.0/16 route. */
  function bridgedContainer(): TrustedPeerSources {
    return namespace(
      [
        routeRow("eth0", DEFAULT_ROUTE, "010011AC", UP_GATEWAY, DEFAULT_ROUTE),
        routeRow("eth0", "000011AC", DEFAULT_ROUTE, UP, MASK_16),
      ],
      { lo: loopback, eth0: { ifindex: 2, devtype: "veth" } },
    );
  }

  test("trusts the container's own bridge gateway once the image opts in", () => {
    expect(resolveTrustedPeers(undefined, optIn, bridgedContainer())).toEqual(["172.17.0.1"]);
  });

  test("stays closed until an operator opts in", () => {
    const container = bridgedContainer();
    expect(resolveTrustedPeers(undefined, {}, container)).toEqual([]);
    // The documented off switch, plus anything that is not exactly "1".
    expect(
      resolveTrustedPeers(undefined, { DECANT_TRUST_DEFAULT_GATEWAY: "0" }, container),
    ).toEqual([]);
    expect(
      resolveTrustedPeers(undefined, { DECANT_TRUST_DEFAULT_GATEWAY: "true" }, container),
    ).toEqual([]);
  });

  test("explicit peers replace the derived gateway instead of adding to it", () => {
    const container = bridgedContainer();
    // An operator narrowing the allowlist gets exactly what they asked for.
    expect(
      resolveTrustedPeers(undefined, { ...optIn, DECANT_TRUSTED_PEERS: "192.168.1.50" }, container),
    ).toEqual(["192.168.1.50"]);
    // Setting the variable at all counts, so an empty value trusts nobody.
    expect(
      resolveTrustedPeers(undefined, { ...optIn, DECANT_TRUSTED_PEERS: "" }, container),
    ).toEqual([]);
    // --trusted-peer outranks both environment variables.
    expect(
      resolveTrustedPeers(
        ["10.9.9.9"],
        { ...optIn, DECANT_TRUSTED_PEERS: "192.168.1.50" },
        container,
      ),
    ).toEqual(["10.9.9.9"]);
  });

  test("refuses a gateway outside the derivation bound", () => {
    // Podman's default bridge is a real container bridge, but 10.88.0.1 sits
    // outside the range this derivation is bounded to, so it needs an explicit
    // peer exactly as it did before.
    const podman = namespace(
      [
        routeRow("eth0", DEFAULT_ROUTE, "0100580A", UP_GATEWAY, DEFAULT_ROUTE),
        routeRow("eth0", "0000580A", DEFAULT_ROUTE, UP, MASK_16),
      ],
      { lo: loopback, eth0: { ifindex: 2, devtype: "veth" } },
    );
    expect(resolveTrustedPeers(undefined, optIn, podman)).toEqual([]);
  });

  test("refuses the host's own network namespace", () => {
    // --network host on a laptop: the "default gateway" is the LAN router.
    const lan = namespace(
      [
        routeRow("eth0", DEFAULT_ROUTE, "0101A8C0", UP_GATEWAY, DEFAULT_ROUTE),
        routeRow("eth0", "0001A8C0", DEFAULT_ROUTE, UP, MASK_24),
      ],
      { lo: loopback, eth0: { ifindex: 2, physical: true } },
    );
    expect(resolveTrustedPeers(undefined, optIn, lan)).toEqual([]);
    // Same shape on a network that happens to fall inside the bound: the
    // physical NIC still gives it away.
    const inRangeLan = namespace(
      [
        routeRow("eth0", DEFAULT_ROUTE, "010510AC", UP_GATEWAY, DEFAULT_ROUTE),
        routeRow("eth0", "000510AC", DEFAULT_ROUTE, UP, MASK_24),
      ],
      { lo: loopback, eth0: { ifindex: 2, physical: true } },
    );
    expect(resolveTrustedPeers(undefined, optIn, inRangeLan)).toEqual([]);
  });

  test("refuses links that are not a veth into another namespace", () => {
    const inRangeDefault = [
      routeRow("eth0", DEFAULT_ROUTE, "010510AC", UP_GATEWAY, DEFAULT_ROUTE),
      routeRow("eth0", "000510AC", DEFAULT_ROUTE, UP, MASK_24),
    ];
    // A macvlan/ipvlan container sits directly on the LAN and publishes its kind.
    const macvlan = namespace(inRangeDefault, {
      lo: loopback,
      eth0: { ifindex: 2, devtype: "macvlan" },
    });
    expect(resolveTrustedPeers(undefined, optIn, macvlan)).toEqual([]);
    // A host bridge, tunnel or bond links to no peer at all.
    const standalone = namespace(inRangeDefault, {
      lo: loopback,
      eth0: { ifindex: 2, iflink: 2 },
    });
    expect(resolveTrustedPeers(undefined, optIn, standalone)).toEqual([]);
    // A device stacked on a parent in this same namespace.
    const stacked = namespace(inRangeDefault, {
      lo: loopback,
      eth0: { ifindex: 2, lowerOf: "eth1" },
      eth1: { ifindex: 3, physical: true },
    });
    expect(resolveTrustedPeers(undefined, optIn, stacked)).toEqual([]);
    // A veth pair with both ends in this namespace is not a container boundary.
    const localPair = namespace(inRangeDefault, {
      lo: loopback,
      eth0: { ifindex: 2, iflink: 3, devtype: "veth" },
      veth1: { ifindex: 3, iflink: 2, devtype: "veth" },
    });
    expect(resolveTrustedPeers(undefined, optIn, localPair)).toEqual([]);
    // An interface name that is not a plain device name never becomes a path.
    const traversal = namespace(
      [
        routeRow("../../etc", DEFAULT_ROUTE, "010510AC", UP_GATEWAY, DEFAULT_ROUTE),
        routeRow("../../etc", "000510AC", DEFAULT_ROUTE, UP, MASK_24),
      ],
      { lo: loopback },
    );
    expect(resolveTrustedPeers(undefined, optIn, traversal)).toEqual([]);
  });

  test("refuses a multi-homed host", () => {
    // Wi-Fi and Ethernet both up: no single gateway stands for "the host".
    const multiHomed = namespace(
      [
        routeRow("eth0", DEFAULT_ROUTE, "010011AC", UP_GATEWAY, DEFAULT_ROUTE),
        routeRow("eth0", "000011AC", DEFAULT_ROUTE, UP, MASK_16),
        routeRow("eth1", DEFAULT_ROUTE, "010510AC", UP_GATEWAY, DEFAULT_ROUTE),
        routeRow("eth1", "000510AC", DEFAULT_ROUTE, UP, MASK_24),
      ],
      {
        lo: loopback,
        eth0: { ifindex: 2, devtype: "veth" },
        eth1: { ifindex: 3, devtype: "veth" },
      },
    );
    expect(resolveTrustedPeers(undefined, optIn, multiHomed)).toEqual([]);
  });

  test("refuses a gateway that is not on-link", () => {
    const offLink = namespace(
      [
        routeRow("eth0", DEFAULT_ROUTE, "010011AC", UP_GATEWAY, DEFAULT_ROUTE),
        routeRow("eth0", "000014AC", DEFAULT_ROUTE, UP, MASK_16),
      ],
      { lo: loopback, eth0: { ifindex: 2, devtype: "veth" } },
    );
    expect(resolveTrustedPeers(undefined, optIn, offLink)).toEqual([]);
  });

  test("refuses an unreadable, defaultless or malformed route table", () => {
    expect(
      resolveTrustedPeers(undefined, optIn, {
        routeTablePath: join(workDir, "no-such-route-table"),
        sysClassNetPath: join(workDir, "no-such-sys-class-net"),
      }),
    ).toEqual([]);
    const onLinkOnly = namespace([routeRow("eth0", "000011AC", DEFAULT_ROUTE, UP, MASK_16)], {
      lo: loopback,
      eth0: { ifindex: 2, devtype: "veth" },
    });
    expect(resolveTrustedPeers(undefined, optIn, onLinkOnly)).toEqual([]);
    const malformedDefaults = [
      // Not hex.
      routeRow("eth0", DEFAULT_ROUTE, "ZZZZZZZZ", UP_GATEWAY, DEFAULT_ROUTE),
      // Flagged as a gateway route with no gateway.
      routeRow("eth0", DEFAULT_ROUTE, DEFAULT_ROUTE, UP_GATEWAY, DEFAULT_ROUTE),
      // On-link default route: RTF_GATEWAY is not set.
      routeRow("eth0", DEFAULT_ROUTE, "010011AC", UP, DEFAULT_ROUTE),
      // Down interface: RTF_UP is not set.
      routeRow("eth0", DEFAULT_ROUTE, "010011AC", "0002", DEFAULT_ROUTE),
      // Truncated row.
      ["eth0", DEFAULT_ROUTE, "010011AC", UP_GATEWAY].join("\t"),
    ];
    for (const malformed of malformedDefaults) {
      const sources = namespace(
        [malformed, routeRow("eth0", "000011AC", DEFAULT_ROUTE, UP, MASK_16)],
        {
          lo: loopback,
          eth0: { ifindex: 2, devtype: "veth" },
        },
      );
      expect(resolveTrustedPeers(undefined, optIn, sources)).toEqual([]);
    }
  });

  test("gateway trust admits the published host but not a bridge sibling", async () => {
    const config = freshConfig();
    const trustedPeers = resolveTrustedPeers(undefined, optIn, bridgedContainer());

    // Forged Host header, source address of a co-located container.
    const sibling = await handleRequest(new Request("http://localhost:3000/api/config"), config, {
      boundHostname: "0.0.0.0",
      remoteAddress: "172.17.0.5",
      trustedPeers,
    });
    expect(sibling.status).toBe(403);
    expect(await sibling.json()).toEqual({
      error: "forbidden remote",
      code: "forbidden_remote",
    });

    // The browser on the host reaches the published port, and Docker forwards
    // it from the container's gateway.
    const published = await handleRequest(new Request("http://127.0.0.1:3000/api/config"), config, {
      boundHostname: "0.0.0.0",
      remoteAddress: "172.17.0.1",
      trustedPeers,
    });
    expect(published.status).toBe(200);
  });
});
