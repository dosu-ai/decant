import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { DECANT_VERSION } from "../src/distill.ts";
import { upsertSession } from "../src/ingest.ts";
import { regenerate } from "../src/recommendations.ts";
import { serve, serviceStartingResponse } from "../src/server.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";

type HttpMethod = "get" | "post";

interface ContractCase {
  path: string;
  method: HttpMethod;
  url: string;
  status?: number;
  body?: unknown;
  expectedCode?: string;
  headers?: Record<string, string>;
  mediaType?: "application/json" | "text/event-stream" | "text/html";
  requestValid?: boolean;
  response?: () => Response | Promise<Response>;
}

interface OpenApiOperation {
  operationId?: string;
  parameters?: Array<{ $ref?: string; in?: string; name?: string }>;
  requestBody?: {
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  responses: Record<
    string,
    {
      $ref?: string;
      content?: Record<string, { schema?: Record<string, unknown> }>;
    }
  >;
  "x-sse-events"?: Record<string, { $ref: string }>;
}

interface OpenApiDocument {
  info: { version: string };
  paths: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
}

const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);

describe("local API OpenAPI contract", () => {
  test("boots a fixture archive and validates every documented operation response", async () => {
    const root = mkdtempSync(join(tmpdir(), "decant-api-contract-"));
    const priorConfigDir = process.env.DECANT_CONFIG_DIR;
    process.env.DECANT_CONFIG_DIR = join(root, "config");
    const config = fixtureConfig(root);
    seed(config);
    const server = serve({
      config,
      hostname: "127.0.0.1",
      port: 0,
      syncRunner: async () => ({
        scanned: 0,
        ingested: 0,
        skipped: 0,
        issues: 0,
        issuesByCode: {},
        failed: 0,
        cancelled: false,
      }),
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const documentResponse = await fetch(`${baseUrl}/api/openapi.json`);
      expect(documentResponse.status).toBe(200);
      const document = (await documentResponse.json()) as OpenApiDocument;
      expect(document.info.version).toBe(DECANT_VERSION);

      const sessions = (await fetchJson(`${baseUrl}/api/sessions?limit=1`)) as {
        id: number;
      }[];
      const sessionId = sessions[0]?.id;
      if (sessionId == null) {
        throw new Error("fixture archive must expose a session");
      }
      const recommendations = (await fetchJson(`${baseUrl}/api/recommendations?status=all`)) as {
        key: string;
      }[];
      const recommendationKey = recommendations[0]?.key;
      if (recommendationKey == null) {
        throw new Error("fixture archive must expose a recommendation");
      }

      const cases: ContractCase[] = [
        { path: "/api/health", method: "get", url: "/api/health" },
        { path: "/api/openapi.json", method: "get", url: "/api/openapi.json" },
        {
          path: "/api/events",
          method: "get",
          url: "/api/events",
          mediaType: "text/event-stream",
        },
        { path: "/api/config", method: "get", url: "/api/config" },
        { path: "/api/settings", method: "get", url: "/api/settings" },
        { path: "/api/settings", method: "post", url: "/api/settings", body: {} },
        {
          path: "/api/launch/agent",
          method: "post",
          url: "/api/launch/agent",
          body: {},
          status: 400,
          requestValid: false,
        },
        {
          path: "/api/launch/ide",
          method: "post",
          url: "/api/launch/ide",
          body: {},
          status: 400,
          requestValid: false,
        },
        { path: "/api/sync-status", method: "get", url: "/api/sync-status" },
        {
          path: "/api/metadata/sync-status",
          method: "get",
          url: "/api/metadata/sync-status",
        },
        { path: "/api/sync", method: "post", url: "/api/sync", body: {} },
        {
          path: "/api/sessions",
          method: "get",
          url: "/api/sessions?limit=1&offset=0&tool=claude_code",
        },
        {
          path: "/api/sessions/search-index",
          method: "get",
          url: "/api/sessions/search-index",
        },
        { path: "/api/projects", method: "get", url: "/api/projects" },
        {
          path: "/api/sessions/{id}/state",
          method: "post",
          url: `/api/sessions/${sessionId}/state`,
          body: { state: "visible" },
        },
        {
          path: "/api/sessions/{id}/token-economics",
          method: "get",
          url: `/api/sessions/${sessionId}/token-economics`,
        },
        {
          path: "/api/sessions/{id}/context-window",
          method: "get",
          url: `/api/sessions/${sessionId}/context-window`,
        },
        {
          path: "/api/sessions/{id}/outline",
          method: "get",
          url: `/api/sessions/${sessionId}/outline`,
        },
        {
          path: "/api/sessions/{id}/issues",
          method: "get",
          url: `/api/sessions/${sessionId}/issues`,
        },
        {
          path: "/api/sessions/{id}",
          method: "get",
          url: `/api/sessions/${sessionId}?message_limit=2&message_offset=0`,
        },
        {
          path: "/api/search",
          method: "post",
          url: "/api/search",
          body: { query: "auth", limit: 1, include_total: false },
        },
        { path: "/api/stats/summary", method: "get", url: "/api/stats/summary" },
        {
          path: "/api/stats/by-dimension",
          method: "get",
          url: "/api/stats/by-dimension?dim=tool",
        },
        {
          path: "/api/analytics/activity",
          method: "get",
          url: "/api/analytics/activity",
        },
        {
          path: "/api/analytics/model-sparklines",
          method: "get",
          url: "/api/analytics/model-sparklines",
        },
        {
          path: "/api/analytics/token-economics",
          method: "get",
          url: "/api/analytics/token-economics",
        },
        { path: "/api/analytics/now", method: "get", url: "/api/analytics/now" },
        {
          path: "/api/reports/analytics.html",
          method: "get",
          url: "/api/reports/analytics.html",
          mediaType: "text/html",
        },
        {
          path: "/api/reports/session/{id}.html",
          method: "get",
          url: `/api/reports/session/${sessionId}.html`,
          mediaType: "text/html",
        },
        { path: "/api/date-bounds", method: "get", url: "/api/date-bounds" },
        {
          path: "/api/metadata/date-bounds",
          method: "get",
          url: "/api/metadata/date-bounds",
        },
        {
          path: "/api/files",
          method: "get",
          url: "/api/files?group=path&limit=10",
        },
        {
          path: "/api/tools/calls",
          method: "get",
          url: "/api/tools/calls?limit=10&offset=0",
        },
        {
          path: "/api/tools/usage",
          method: "get",
          url: "/api/tools/usage?limit=10",
        },
        {
          path: "/api/tools/mcp-usage",
          method: "get",
          url: "/api/tools/mcp-usage?limit=10",
        },
        {
          path: "/api/recommendations",
          method: "get",
          url: "/api/recommendations?status=all",
        },
        {
          path: "/api/recommendations/mark",
          method: "post",
          url: "/api/recommendations/mark",
          body: { key: recommendationKey, source: "api-contract", note: "fixture-only" },
        },
      ];
      const errorCases: ContractCase[] = [
        {
          path: "/api/health",
          method: "get",
          url: "/api/health",
          status: 503,
          expectedCode: "service_starting",
          response: serviceStartingResponse,
        },
        {
          path: "/api/health",
          method: "get",
          url: "/api/health",
          status: 403,
          expectedCode: "forbidden_host",
          headers: { host: "remote.invalid" },
        },
        {
          path: "/api/sessions/{id}",
          method: "get",
          url: "/api/sessions/not-a-number",
          status: 400,
          expectedCode: "invalid_session_id",
        },
        {
          path: "/api/sessions/{id}",
          method: "get",
          url: "/api/sessions/999999999",
          status: 404,
          expectedCode: "session_not_found",
        },
        {
          path: "/api/search",
          method: "post",
          url: "/api/search",
          body: {},
          status: 400,
          expectedCode: "query_required",
          requestValid: false,
        },
        {
          path: "/api/stats/by-dimension",
          method: "get",
          url: "/api/stats/by-dimension?dim=unknown",
          status: 400,
          expectedCode: "unknown_dimension",
        },
        {
          path: "/api/files",
          method: "get",
          url: "/api/files?group=unknown",
          status: 400,
          expectedCode: "invalid_files_query",
        },
        {
          path: "/api/recommendations",
          method: "get",
          url: "/api/recommendations?status=unknown",
          status: 400,
          expectedCode: "unknown_status",
        },
        {
          path: "/api/settings",
          method: "post",
          url: "/api/settings",
          body: {},
          headers: { "content-type": "text/plain" },
          status: 415,
          expectedCode: "unsupported_media_type",
        },
      ];

      expect(operationKeys(document)).toEqual(
        cases.map((entry) => `${entry.method.toUpperCase()} ${entry.path}`).sort(),
      );

      const ajv = new Ajv2020({
        allErrors: true,
        strict: false,
        validateFormats: false,
      });
      ajv.addSchema(document, "decant-openapi");
      expect(validateDocumentSchemas(ajv, document)).toBeGreaterThan(100);
      expect(parameterNames(document, "/api/sessions", "get")).toEqual([
        "from",
        "include_archived",
        "include_subagents",
        "limit",
        "model",
        "offset",
        "project",
        "to",
        "tool",
        "with_subagents",
      ]);
      expect(parameterNames(document, "/api/stats/summary", "get")).toEqual([
        "from",
        "include_archived",
        "project",
        "to",
        "tool",
      ]);
      expect(parameterNames(document, "/api/stats/by-dimension", "get")).toEqual([
        "dim",
        "from",
        "include_archived",
        "project",
        "to",
        "tool",
      ]);
      expect(requestPropertyNames(document, "/api/search", "post")).toContain("include_total");
      expect(requestPropertyNames(document, "/api/sessions/{id}/state", "post")).toEqual(["state"]);
      expect(operationDescription(document, "/api/sessions", "get")).toContain(
        "A final short or empty page marks the end",
      );
      expect(operationDescription(document, "/api/sessions/search-index", "get")).toContain(
        "top-level",
      );
      const routesDocumentation = readFileSync(
        join(import.meta.dir, "..", "docs", "api", "routes.md"),
        "utf8",
      );
      expect(routesDocumentation).toContain("## UI routes");
      expect(routesDocumentation).toContain("GET /api/sessions/search-index");
      expect(routesDocumentation).toMatch(/final short\s+or empty page/);
      expect(sseEventNames(document)).toEqual([
        "archive_updated",
        "error",
        "hello",
        "ping",
        "ready",
        "stopped",
        "sync",
        "sync_progress",
      ]);
      const validators = new Map<string, ValidateFunction>();

      for (const contractCase of [...cases, ...errorCases]) {
        const expectedStatus = contractCase.status ?? 200;
        const expectedMediaType = contractCase.mediaType ?? "application/json";
        const response =
          contractCase.response == null
            ? await fetch(`${baseUrl}${contractCase.url}`, {
                method: contractCase.method.toUpperCase(),
                ...(contractCase.body === undefined
                  ? { headers: contractCase.headers }
                  : {
                      body: JSON.stringify(contractCase.body),
                      headers: {
                        "content-type": "application/json",
                        ...contractCase.headers,
                      },
                    }),
              })
            : await contractCase.response();
        expect(response.status).toBe(expectedStatus);
        expect(response.headers.get("content-type")).toStartWith(expectedMediaType);
        if (contractCase.body !== undefined) {
          const validateRequest = compileRequestValidator(
            ajv,
            contractCase.path,
            contractCase.method,
          );
          expect(validateRequest(contractCase.body)).toBe(contractCase.requestValid !== false);
        }

        const value =
          expectedMediaType === "application/json"
            ? await response.json()
            : expectedMediaType === "text/event-stream"
              ? await firstStreamChunk(response)
              : await response.text();
        if (contractCase.expectedCode != null) {
          expect(value).toMatchObject({ code: contractCase.expectedCode });
        }
        if (expectedMediaType === "text/event-stream") {
          const frame = parseSseFrame(value as string);
          expect(frame.event).toBe("hello");
          const validateEvent = compileSseEventValidator(ajv, frame.event);
          if (!validateEvent(frame.data)) {
            throw new Error(
              `SSE ${frame.event} violated its schema: ` +
                ajv.errorsText(validateEvent.errors, { separator: "\n" }),
            );
          }
        }

        const validatorKey = [
          contractCase.path,
          contractCase.method,
          expectedStatus,
          expectedMediaType,
        ].join("|");
        let validate = validators.get(validatorKey);
        if (validate == null) {
          validate = compileResponseValidator(
            ajv,
            contractCase.path,
            contractCase.method,
            expectedStatus,
            expectedMediaType,
          );
          validators.set(validatorKey, validate);
        }
        if (!validate(value)) {
          throw new Error(
            `${contractCase.method.toUpperCase()} ${contractCase.path} violated its ` +
              `${expectedStatus} schema: ${ajv.errorsText(validate.errors, { separator: "\n" })}`,
          );
        }
      }
    } finally {
      await server.stop(true);
      if (priorConfigDir == null) {
        delete process.env.DECANT_CONFIG_DIR;
      } else {
        process.env.DECANT_CONFIG_DIR = priorConfigDir;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function fixtureConfig(root: string): Config {
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "codex");
  const geminiDir = join(root, "gemini");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(geminiDir, { recursive: true });
  return {
    dbPath: join(root, "archive.db"),
    claudeDir,
    codexDir,
    geminiDir,
  };
}

function seed(config: Config): void {
  const db = openDb(config.dbPath);
  const fixture = (tool: "claude" | "codex", name: string): string =>
    readFileSync(join(import.meta.dir, "..", "fixtures", tool, name), "utf8");
  upsertSession(
    db,
    parseClaudeSession("contract-claude", fixture("claude", "sample.jsonl")),
    "/synthetic/claude.jsonl",
    1,
    2,
    "contract-claude",
  );
  upsertSession(
    db,
    parseCodexSession("contract-codex", fixture("codex", "enriched.jsonl"), new Map()),
    "/synthetic/codex.jsonl",
    1,
    2,
    "contract-codex",
  );
  regenerate(db);
  db.close();
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return await response.json();
}

async function firstStreamChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader == null) {
    throw new Error("SSE response did not expose a body");
  }
  try {
    const { value, done } = await reader.read();
    if (done || value == null) {
      throw new Error("SSE response ended before its hello event");
    }
    return new TextDecoder().decode(value);
  } finally {
    await reader.cancel();
  }
}

function operationKeys(document: OpenApiDocument): string[] {
  return Object.entries(document.paths)
    .flatMap(([path, item]) =>
      Object.keys(item)
        .filter((key): key is HttpMethod => HTTP_METHODS.has(key))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

function validateDocumentSchemas(ajv: Ajv2020, document: OpenApiDocument): number {
  const compiled = new Set<string>();
  const compilePointer = (pointer: string): void => {
    if (compiled.has(pointer)) {
      return;
    }
    try {
      ajv.compile({ $ref: `decant-openapi#${pointer}` });
    } catch (error) {
      throw new Error(
        `invalid OpenAPI schema at ${pointer}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    compiled.add(pointer);
  };
  const walk = (value: unknown, segments: string[]): void => {
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) {
        walk(child, [...segments, String(index)]);
      }
      return;
    }
    if (value == null || typeof value !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const childSegments = [...segments, key];
      if (key === "schema" && child != null && typeof child === "object") {
        compilePointer(`/${childSegments.map(jsonPointer).join("/")}`);
      }
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) {
        try {
          resolveLocalRef(document, child);
        } catch (error) {
          throw new Error(
            `invalid OpenAPI reference at /${childSegments
              .map(jsonPointer)
              .join("/")}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      walk(child, childSegments);
    }
  };

  const schemas = resolveLocalRef<Record<string, unknown>>(document, "#/components/schemas");
  for (const name of Object.keys(schemas)) {
    compilePointer(`/components/schemas/${jsonPointer(name)}`);
  }
  walk(document, []);
  return compiled.size;
}

function parameterNames(document: OpenApiDocument, path: string, method: HttpMethod): string[] {
  return (document.paths[path]?.[method]?.parameters ?? [])
    .map((parameter) =>
      parameter.$ref == null
        ? parameter.name
        : resolveLocalRef<{ name?: string }>(document, parameter.$ref).name,
    )
    .filter((name): name is string => name != null)
    .sort();
}

function requestPropertyNames(
  document: OpenApiDocument,
  path: string,
  method: HttpMethod,
): string[] {
  const schema = document.paths[path]?.[method]?.requestBody?.content?.["application/json"]?.schema;
  if (schema == null) {
    throw new Error(`${method.toUpperCase()} ${path} does not document a JSON request body`);
  }
  const resolved =
    typeof schema.$ref === "string"
      ? resolveLocalRef<{ properties?: Record<string, unknown> }>(document, schema.$ref)
      : (schema as { properties?: Record<string, unknown> });
  return Object.keys(resolved.properties ?? {}).sort();
}

function operationDescription(document: OpenApiDocument, path: string, method: HttpMethod): string {
  return (
    (document.paths[path]?.[method] as { description?: string } | undefined)?.description ?? ""
  );
}

function sseEventNames(document: OpenApiDocument): string[] {
  return Object.keys(document.paths["/api/events"]?.get?.["x-sse-events"] ?? {}).sort();
}

function compileRequestValidator(ajv: Ajv2020, path: string, method: HttpMethod): ValidateFunction {
  const operation = openApiFromAjv(ajv).paths[path]?.[method];
  if (operation?.requestBody?.content?.["application/json"]?.schema == null) {
    throw new Error(`${method.toUpperCase()} ${path} does not document a JSON request body`);
  }
  return ajv.compile({
    $ref:
      `decant-openapi#/paths/${jsonPointer(path)}/${method}/requestBody/content/` +
      `${jsonPointer("application/json")}/schema`,
  });
}

function compileSseEventValidator(ajv: Ajv2020, event: string): ValidateFunction {
  const events = openApiFromAjv(ajv).paths["/api/events"]?.get?.["x-sse-events"];
  if (events?.[event] == null) {
    throw new Error(`GET /api/events does not document the ${event} event`);
  }
  return ajv.compile({
    $ref:
      `decant-openapi#/paths/${jsonPointer("/api/events")}/get/` +
      `${jsonPointer("x-sse-events")}/${jsonPointer(event)}`,
  });
}

function parseSseFrame(value: string): { data: unknown; event: string } {
  const event = value.match(/^event: ([^\r\n]+)$/m)?.[1];
  const data = value.match(/^data: (.+)$/m)?.[1];
  if (event == null || data == null) {
    throw new Error(`invalid SSE frame: ${value.slice(0, 200)}`);
  }
  return { event, data: JSON.parse(data) };
}

function compileResponseValidator(
  ajv: Ajv2020,
  path: string,
  method: HttpMethod,
  status: number,
  mediaType: string,
): ValidateFunction {
  const document = openApiFromAjv(ajv);
  const operation = document.paths?.[path]?.[method];
  const documentedResponse = operation?.responses[String(status)];
  const response =
    documentedResponse?.$ref == null
      ? documentedResponse
      : resolveLocalRef<OpenApiOperation["responses"][string]>(document, documentedResponse.$ref);
  const schema = response?.content?.[mediaType]?.schema;
  if (schema == null) {
    throw new Error(`${method.toUpperCase()} ${path} does not document ${status} ${mediaType}`);
  }
  if (documentedResponse?.$ref != null) {
    return ajv.compile({
      $ref:
        `decant-openapi${documentedResponse.$ref}/content/` + `${jsonPointer(mediaType)}/schema`,
    });
  }
  return ajv.compile({
    $ref:
      `decant-openapi#/paths/${jsonPointer(path)}/${method}/responses/${status}/content/` +
      `${jsonPointer(mediaType)}/schema`,
  });
}

function openApiFromAjv(ajv: Ajv2020): OpenApiDocument {
  return (
    (ajv.getSchema("decant-openapi")?.schema as OpenApiDocument | undefined) ??
    ({} as OpenApiDocument)
  );
}

function resolveLocalRef<T>(document: OpenApiDocument, ref: string): T {
  if (!ref.startsWith("#/")) {
    throw new Error(`only local OpenAPI refs are supported, got ${ref}`);
  }
  let value: unknown = document;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value == null || typeof value !== "object" || !(segment in value)) {
      throw new Error(`unresolved OpenAPI ref ${ref}`);
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value as T;
}

function jsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
