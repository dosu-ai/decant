import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.ts";
import { ARCHIVE_DIR_MODE, closeDb, openDb } from "../db.ts";
import { type Db, ensureDerivedMetadata, type RequestContext } from "./context.ts";
import { executeReadOp, type ReadOpArgs, type ReadOpName, type ReadOpOutput } from "./read-ops.ts";
import { ReadPoolClosedError } from "./read-pool.ts";

/**
 * Run a read operation for a request: on the server's read pool when there is
 * one, otherwise inline on the request's connection. Null means the session
 * the operation names does not exist.
 */
export async function runRead<N extends ReadOpName>(
  config: Config,
  context: RequestContext,
  name: N,
  args: ReadOpArgs<N>,
  signal?: AbortSignal,
): Promise<ReadOpOutput | null> {
  if (context.readPool != null && context.db != null) {
    // Derived metadata is written through the server's connection; the
    // workers' read-only connections only ever read it.
    ensureDerivedMetadata(context.db);
    try {
      return await context.readPool.run(name, args, { signal });
    } catch (error) {
      // While the server stops, the pool closes before the listener does.
      // Requests that arrive or are in flight in that window still get an
      // answer from the server's connection, which stays open until the
      // listener has stopped, as they did before the pool existed.
      if (!(error instanceof ReadPoolClosedError)) {
        throw error;
      }
      return await executeReadOp(context.db, name, args);
    }
  }
  return await withDbAsync(config, context, (db) => executeReadOp(db, name, args));
}

/** Like withDb, but keeps a connection it opened alive until `callback`
 * settles, since report operations await a lazy import mid-read. */
async function withDbAsync<T>(
  config: Config,
  context: RequestContext,
  callback: (db: Db) => Promise<T>,
): Promise<T> {
  if (context.db != null) {
    ensureDerivedMetadata(context.db);
    return await callback(context.db);
  }
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: ARCHIVE_DIR_MODE });
  const db = openDb(config.dbPath);
  try {
    ensureDerivedMetadata(db);
    return await callback(db);
  } finally {
    closeDb(db);
  }
}

export function readOutputResponse(output: ReadOpOutput): Response {
  if (output.type === "html") {
    return reportHtmlResponse(output.body, output.filename);
  }
  return new Response(output.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function reportHtmlResponse(value: string, filename: string): Response {
  return new Response(value, {
    headers: {
      "content-disposition": `attachment; filename="${filename}"`,
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
