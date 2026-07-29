import {
  configureSync,
  getJsonLinesFormatter,
  getLogger,
  type Logger,
  type LogLevel,
  type Sink,
} from "@logtape/logtape";
import type { WatchEvent } from "./watch.ts";

export const DEFAULT_LOG_LEVEL: LogLevel = "info";
export type StructuredLogger = Logger;

export interface StructuredLogRecord extends Record<string, unknown> {
  "@timestamp": string;
  level: string;
  logger: string;
  message: string;
}

export interface ConfigureLoggingOptions {
  level?: string;
  write?: (line: string) => void;
}

/**
 * Configures the application logging boundary. Library-style modules only call
 * getDecantLogger(); the CLI entry point decides whether and where records are
 * emitted.
 */
export function configureLogging(options: ConfigureLoggingOptions = {}): void {
  const configuredLevel = normalizeLogLevel(options.level);
  const formatter = getJsonLinesFormatter({ properties: "flatten" });
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const stderr: Sink = (record) => write(formatter(record));

  configureSync({
    sinks: { stderr },
    loggers: [
      {
        category: ["logtape", "meta"],
        sinks: [],
        lowestLevel: null,
        parentSinks: "override",
      },
      {
        category: ["decant"],
        sinks: ["stderr"],
        lowestLevel: configuredLevel.level,
      },
    ],
  });

  if (configuredLevel.invalid != null) {
    getDecantLogger("logging").warning("Invalid log level; using info.", {
      "event.name": "decant.logging.configuration.invalid",
      "log.level.requested": configuredLevel.invalid,
      "log.level.fallback": DEFAULT_LOG_LEVEL,
    });
  }
}

export function getDecantLogger(component: string): Logger {
  return getLogger(["decant", component]).with({ "service.name": "decant" });
}

export function logWatchEvent(logger: Logger, event: WatchEvent): void {
  switch (event.type) {
    case "ready":
      logger.info("Watcher ready.", {
        "event.name": "decant.watch.ready",
        "source.directory.count": event.dirs.length,
      });
      break;
    case "sync":
      logger.info("Archive sync completed.", {
        "event.name": "decant.sync.completed",
        "sync.reason": event.reason,
        "sync.files.scanned": event.report.scanned,
        "sync.files.ingested": event.report.ingested,
        "sync.files.skipped": event.report.skipped,
        "sync.issue.count": event.report.issues,
        "sync.failure.count": event.report.failed,
        "sync.cancelled": event.report.cancelled,
      });
      break;
    case "error":
      logger.error("Archive sync failed.", {
        "event.name": "decant.sync.exception",
        "sync.reason": event.reason,
        "exception.type": "SyncError",
        "exception.message": event.error,
      });
      break;
    case "stopped":
      logger.info("Watcher stopped.", {
        "event.name": "decant.watch.stopped",
        "sync.run.count": event.status.runs,
      });
      break;
  }
}

export function logHttpRequest(
  logger: Logger,
  request: Request,
  response: Response,
  durationMs: number,
): void {
  const url = new URL(request.url);
  const properties = {
    "event.name": "http.server.request",
    "event.duration_ms": Math.round(durationMs * 100) / 100,
    "http.request.method": request.method,
    "http.response.status_code": response.status,
    "http.route": httpRoute(url.pathname),
    "server.address": url.hostname,
    "server.port": url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
  };
  if (response.status >= 500) {
    logger.error("HTTP request completed.", {
      ...properties,
      "error.type": String(response.status),
    });
  } else if (response.status >= 400) {
    logger.warning("HTTP request completed.", properties);
  } else {
    logger.info("HTTP request completed.", properties);
  }
}

export function exceptionAttributes(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      "exception.type": error.name,
      "exception.message": error.message,
      ...(error.stack == null ? {} : { "exception.stacktrace": error.stack }),
    };
  }
  return {
    "exception.type": typeof error,
    "exception.message": String(error),
  };
}

function httpRoute(pathname: string): string {
  const sessionDetail = pathname.match(
    /^\/api\/sessions\/[^/]+\/(token-economics|context-window|outline|issues|state)$/,
  );
  if (sessionDetail != null) {
    return `/api/sessions/{id}/${sessionDetail[1]}`;
  }
  if (pathname !== "/api/sessions/search-index" && /^\/api\/sessions\/[^/]+$/.test(pathname)) {
    return "/api/sessions/{id}";
  }
  if (/^\/api\/reports\/session\/[^/]+\.html$/.test(pathname)) {
    return "/api/reports/session/{id}.html";
  }
  if (/^\/sessions\/[^/]+$/.test(pathname)) {
    return "/sessions/{id}";
  }
  if (/^\/reports\/session\/[^/]+$/.test(pathname)) {
    return "/reports/session/{id}";
  }
  if (pathname.startsWith("/src/ui/")) {
    return "/src/ui/*";
  }
  return pathname;
}

function normalizeLogLevel(value: string | undefined): {
  level: LogLevel | null;
  invalid: string | null;
} {
  const normalized = value?.trim().toLowerCase();
  if (normalized == null || normalized === "") {
    return { level: DEFAULT_LOG_LEVEL, invalid: null };
  }
  if (normalized === "off" || normalized === "silent") {
    return { level: null, invalid: null };
  }
  if (normalized === "warn") {
    return { level: "warning", invalid: null };
  }
  if (
    normalized === "trace" ||
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warning" ||
    normalized === "error" ||
    normalized === "fatal"
  ) {
    return { level: normalized, invalid: null };
  }
  return { level: DEFAULT_LOG_LEVEL, invalid: value ?? "" };
}
