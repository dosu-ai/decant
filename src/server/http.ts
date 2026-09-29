import { SchemaDriftError, SchemaTooNewError, SchemaTooOldError } from "../db.ts";

export type ApiErrorCode =
  | "archive_locked"
  | "cross_origin_write"
  | "forbidden_host"
  | "forbidden_remote"
  | "internal_error"
  | "invalid_files_query"
  | "invalid_request"
  | "invalid_session_id"
  | "launch_failed"
  | "launch_unsupported_platform"
  | "malformed_body"
  | "not_found"
  | "query_required"
  | "recommendation_not_found"
  | "schema_drift"
  | "schema_too_new"
  | "schema_too_old"
  | "service_starting"
  | "session_not_found"
  | "unknown_dimension"
  | "unknown_status"
  | "unsupported_media_type";

interface ApiError {
  code: ApiErrorCode;
  message: string;
  extras?: Record<string, unknown>;
  status: number;
}

class RequestBodyError extends Error {
  constructor() {
    super("request body must be valid JSON");
    this.name = "RequestBodyError";
  }
}

export function notFoundResponse(): Response {
  return errorResponse("not_found", "not found", {}, 404);
}

export function errorResponse(
  code: ApiErrorCode,
  message: string,
  extras: Record<string, unknown> = {},
  status = 400,
): Response {
  return json({ error: message, code, ...extras }, status);
}

/** Stable startup response shared by the live guard and contract tests. */
export function serviceStartingResponse(): Response {
  return errorResponse(
    "service_starting",
    "Decant is still starting. Please try again.",
    { retryable: true },
    503,
  );
}

export function responseForError(error: unknown): Response {
  const mapped = classifyError(error);
  return errorResponse(mapped.code, mapped.message, mapped.extras, mapped.status);
}

function classifyError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RequestBodyError) {
    return { code: "malformed_body", message, status: 400 };
  }
  if (error instanceof SchemaDriftError) {
    return { code: "schema_drift", message, status: 409 };
  }
  if (error instanceof SchemaTooNewError || error instanceof SchemaTooOldError) {
    return { code: error.code, message, status: 409 };
  }
  const normalized = message.toLowerCase();
  if (isArchiveLockedError(error, normalized)) {
    return {
      code: "archive_locked",
      message: "Session logs are temporarily busy. Please try again.",
      extras: { retryable: true },
      status: 503,
    };
  }
  return {
    code: "internal_error",
    message: "Decant could not complete this request.",
    status: 500,
  };
}

function isArchiveLockedError(error: unknown, normalizedMessage: string): boolean {
  const code =
    typeof error === "object" && error != null && "code" in error
      ? String((error as { code?: unknown }).code).toUpperCase()
      : "";
  return (
    code.startsWith("SQLITE_BUSY") ||
    code.startsWith("SQLITE_LOCKED") ||
    normalizedMessage.includes("database is locked") ||
    normalizedMessage.includes("database table is locked") ||
    normalizedMessage.includes("database is busy")
  );
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requireJsonRequest(request: Request): Response | null {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json"
    ? null
    : errorResponse("unsupported_media_type", "content-type must be application/json", {}, 415);
}

export async function readJsonBody(
  request: Request,
  rejectExtras?: Record<string, unknown>,
): Promise<Response | { body: Record<string, unknown> }>;
export async function readJsonBody(
  request: Request,
  rejectExtras: null,
): Promise<Response | { body: unknown }>;
export async function readJsonBody(
  request: Request,
  rejectExtras: Record<string, unknown> | null = {},
): Promise<Response | { body: unknown }> {
  const contentTypeFailure = requireJsonRequest(request);
  if (contentTypeFailure != null) {
    return contentTypeFailure;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new RequestBodyError();
  }
  if (rejectExtras != null && !isJsonObject(body)) {
    return errorResponse(
      "invalid_request",
      "request body must be a JSON object",
      rejectExtras,
      400,
    );
  }
  return { body };
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
