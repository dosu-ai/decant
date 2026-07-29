import { afterEach, describe, expect, test } from "bun:test";
import { resetSync } from "@logtape/logtape";
import {
  configureLogging,
  getDecantLogger,
  logHttpRequest,
  logWatchEvent,
  type StructuredLogRecord,
} from "../src/logging.ts";

afterEach(() => resetSync());

describe("structured logging", () => {
  test("writes flattened JSON Lines records to stderr", () => {
    const lines: string[] = [];
    configureLogging({
      level: "debug",
      write: (line) => lines.push(line),
    });

    getDecantLogger("test").info("Archive sync completed.", {
      "event.name": "decant.sync.completed",
      "sync.reason": "startup",
      "sync.ingested": 3,
    });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "") as StructuredLogRecord;
    expect(record).toMatchObject({
      level: "INFO",
      logger: "decant.test",
      message: "Archive sync completed.",
      "service.name": "decant",
      "event.name": "decant.sync.completed",
      "sync.reason": "startup",
      "sync.ingested": 3,
    });
    expect(record["@timestamp"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("normalizes warn and reports invalid configured levels", () => {
    const warnLines: string[] = [];
    configureLogging({
      level: "warn",
      write: (line) => warnLines.push(line),
    });
    const warnLogger = getDecantLogger("test");
    warnLogger.info("Filtered.");
    warnLogger.warning("Kept.");
    expect(warnLines).toHaveLength(1);
    expect(JSON.parse(warnLines[0] ?? "")).toMatchObject({
      level: "WARN",
      message: "Kept.",
    });

    resetSync();
    const invalidLines: string[] = [];
    configureLogging({
      level: "verbose",
      write: (line) => invalidLines.push(line),
    });
    expect(JSON.parse(invalidLines[0] ?? "")).toMatchObject({
      level: "WARN",
      "event.name": "decant.logging.configuration.invalid",
      "log.level.requested": "verbose",
      "log.level.fallback": "info",
    });
  });

  test("supports LogTape's trace level without degrading it to debug", () => {
    const lines: string[] = [];
    configureLogging({
      level: "trace",
      write: (line) => lines.push(line),
    });

    getDecantLogger("test").trace("Detailed flow.");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "TRACE",
      message: "Detailed flow.",
    });
  });

  test("maps watcher events to stable operational fields without source paths", () => {
    const lines: string[] = [];
    configureLogging({
      level: "info",
      write: (line) => lines.push(line),
    });

    logWatchEvent(getDecantLogger("watch"), {
      type: "ready",
      dirs: ["/private/transcript-a", "/private/transcript-b"],
      status: {
        last_sync_at: null,
        in_progress: false,
        last_report: null,
        last_error: null,
        ingested_count: null,
        runs: 0,
      },
    });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "") as StructuredLogRecord;
    expect(record).toMatchObject({
      "event.name": "decant.watch.ready",
      "source.directory.count": 2,
    });
    expect(lines[0]).not.toContain("/private/transcript");
  });

  test("records HTTP outcomes without logging query strings", () => {
    const lines: string[] = [];
    configureLogging({
      level: "info",
      write: (line) => lines.push(line),
    });
    logHttpRequest(
      getDecantLogger("server").with({ "request.id": "req-test" }),
      new Request("http://127.0.0.1:3000/api/health?private=do-not-log"),
      new Response(null, { status: 200 }),
      4.25,
    );

    const record = lines
      .map((line) => JSON.parse(line) as StructuredLogRecord)
      .find((candidate) => candidate["event.name"] === "http.server.request");
    expect(record).toMatchObject({
      level: "INFO",
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "http.route": "/api/health",
      "request.id": "req-test",
    });
    expect(record?.["event.duration_ms"]).toBeNumber();
    expect(lines.join("")).not.toContain("do-not-log");
  });

  test("normalizes dynamic session and report routes", () => {
    const lines: string[] = [];
    configureLogging({
      level: "info",
      write: (line) => lines.push(line),
    });
    const logger = getDecantLogger("server");
    const routes = [
      ["/api/sessions/42", "/api/sessions/{id}"],
      ["/api/sessions/42/token-economics", "/api/sessions/{id}/token-economics"],
      ["/api/sessions/not-a-number/context-window", "/api/sessions/{id}/context-window"],
      ["/api/sessions/42/outline", "/api/sessions/{id}/outline"],
      ["/api/sessions/42/issues", "/api/sessions/{id}/issues"],
      ["/api/sessions/42/state", "/api/sessions/{id}/state"],
      ["/api/reports/session/not-a-number.html", "/api/reports/session/{id}.html"],
      ["/sessions/not-a-number", "/sessions/{id}"],
      ["/reports/session/not-a-number", "/reports/session/{id}"],
      ["/api/sessions/search-index", "/api/sessions/search-index"],
    ] as const;

    for (const [pathname] of routes) {
      logHttpRequest(logger, new Request(`http://127.0.0.1:3000${pathname}`), new Response(), 1);
    }

    const records = lines.map((line) => JSON.parse(line) as StructuredLogRecord);
    expect(records.map((record) => record["http.route"])).toEqual(
      routes.map(([, normalized]) => normalized),
    );
  });

  test("records standard ports when an HTTP URL omits an explicit port", () => {
    const lines: string[] = [];
    configureLogging({
      level: "info",
      write: (line) => lines.push(line),
    });
    const logger = getDecantLogger("server");

    logHttpRequest(logger, new Request("http://localhost/"), new Response(), 1);
    logHttpRequest(logger, new Request("https://localhost/"), new Response(), 1);

    const records = lines.map((line) => JSON.parse(line) as StructuredLogRecord);
    expect(records.map((record) => record["server.port"])).toEqual([80, 443]);
  });
});
