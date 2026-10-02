import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { openApiDocument } from "../src/openapi.ts";
import { API_ROUTE_PATHS, routeTemplate, UI_ROUTE_PATHS } from "../src/route-paths.ts";
import { ROUTES } from "../src/server/routes.ts";
import { handleRequest } from "../src/server.ts";

const METHODS = ["GET", "POST"] as const;

describe("route table", () => {
  test("matches the OpenAPI paths and methods exactly", () => {
    const tableRoutes = API_ROUTE_PATHS.flatMap((path) =>
      METHODS.filter((method) => ROUTES[path][method] != null).map((method) => `${method} ${path}`),
    );
    const documented = Object.entries(
      (openApiDocument("0.0.0") as unknown as { paths: Record<string, object> }).paths,
    ).flatMap(([path, operations]) =>
      Object.keys(operations)
        .filter((key) => ["get", "post", "put", "patch", "delete"].includes(key))
        .map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(tableRoutes.sort()).toEqual(documented.sort());
  });

  test("lists the literal search-index path before the {id} detail path", () => {
    expect(API_ROUTE_PATHS.indexOf("/api/sessions/search-index")).toBeLessThan(
      API_ROUTE_PATHS.indexOf("/api/sessions/{id}"),
    );
  });

  test("derives http.route templates from the manifest", () => {
    expect(routeTemplate("/api/sessions/42")).toBe("/api/sessions/{id}");
    expect(routeTemplate("/api/sessions/abc/state")).toBe("/api/sessions/{id}/state");
    expect(routeTemplate("/api/sessions/search-index")).toBe("/api/sessions/search-index");
    expect(routeTemplate("/api/reports/session/7.html")).toBe("/api/reports/session/{id}.html");
    expect(routeTemplate("/api/reports/analytics.html")).toBe("/api/reports/analytics.html");
    expect(routeTemplate("/api/reportsXanalytics.html")).toBe("/api/reportsXanalytics.html");
    expect(routeTemplate("/sessions/7")).toBe("/sessions/{id}");
    expect(routeTemplate("/reports/session/7")).toBe("/reports/session/{id}");
    expect(routeTemplate("/src/ui/main.js")).toBe("/src/ui/*");
    expect(routeTemplate("/unknown/path")).toBe("/unknown/path");
    for (const path of UI_ROUTE_PATHS.filter((candidate) => !candidate.includes("{id}"))) {
      expect(routeTemplate(path)).toBe(path);
    }
  });
});

describe("route dispatch edge cases", () => {
  const workDir = mkdtempSync(join(tmpdir(), "decant-server-routes-"));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));
  const root = join(workDir, "case");
  mkdirSync(join(root, "claude"), { recursive: true });
  const config: Config = {
    dbPath: join(root, "archive.db"),
    claudeDir: join(root, "claude"),
    codexDir: join(root, "codex"),
    geminiDir: join(root, "gemini"),
  };

  async function call(
    method: string,
    path: string,
  ): Promise<{ status: number; code: string | undefined }> {
    const response = await handleRequest(
      new Request(`http://127.0.0.1:3000${path}`, {
        method,
        headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" },
        body: method === "GET" || method === "HEAD" ? undefined : "{}",
      }),
      config,
    );
    const body = (await response.json()) as { code?: string };
    return { status: response.status, code: body.code };
  }

  test("rejects malformed session ids on GET and POST even without a handler", async () => {
    expect(await call("GET", "/api/sessions/abc")).toEqual({
      status: 400,
      code: "invalid_session_id",
    });
    expect(await call("GET", "/api/sessions/0/state")).toEqual({
      status: 400,
      code: "invalid_session_id",
    });
    expect(await call("POST", "/api/sessions/search-index")).toEqual({
      status: 400,
      code: "invalid_session_id",
    });
  });

  test("answers 404 for unrouted methods and valid ids without a handler", async () => {
    expect(await call("DELETE", "/api/sessions/abc")).toEqual({ status: 404, code: "not_found" });
    expect(await call("POST", "/api/sessions/5")).toEqual({ status: 404, code: "not_found" });
    expect(await call("GET", "/api/sessions/5/state")).toEqual({
      status: 404,
      code: "not_found",
    });
    expect(await call("POST", "/api/reports/session/abc.html")).toEqual({
      status: 404,
      code: "not_found",
    });
    expect(await call("GET", "/api/health/")).toEqual({ status: 404, code: "not_found" });
  });
});
