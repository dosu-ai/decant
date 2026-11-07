import { ReadConnection } from "./read-connection.ts";
import { executeReadOp, isReadOpName } from "./server/read-ops.ts";

/**
 * Long-lived read worker for `decant serve` (see src/server/read-pool.ts). It
 * keeps one read-only connection, so its read cache and page cache stay warm
 * between requests, and runs the operations in src/server/read-ops.ts.
 *
 * Messages in:  init { dbPath } | warm | run { id, name, args } |
 *               reload-statistics | close
 * Messages out: result { id, ok, output | error }. After `close` the worker
 * closes its connection and exits; the pool waits for that exit.
 */

let connection: ReadConnection | null = null;

function serializeError(error: unknown): {
  name: string;
  message: string;
  code?: string;
  stack?: string;
} {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(code == null ? {} : { code: String(code) }),
      ...(error.stack == null ? {} : { stack: error.stack }),
    };
  }
  return { name: "Error", message: String(error) };
}

async function run(id: number, name: unknown, args: unknown): Promise<void> {
  try {
    if (connection == null) {
      throw new Error("read worker used before init");
    }
    if (!isReadOpName(name)) {
      throw new Error(`unknown read operation: ${String(name)}`);
    }
    const output = await connection.use((db) =>
      // biome-ignore lint/suspicious/noExplicitAny: the pool types arguments against READ_OPS before sending them.
      executeReadOp(db, name, args as any),
    );
    self.postMessage({ type: "result", id, ok: true, output });
  } catch (error) {
    self.postMessage({ type: "result", id, ok: false, error: serializeError(error) });
  }
}

self.addEventListener("message", function onMessage(event) {
  // Dedicated worker: the only sender is the spawning parent thread, whose
  // messages carry an empty origin. Drop anything else.
  if (event.origin !== "") {
    return;
  }
  const data = event.data as { type?: unknown };
  switch (data.type) {
    case "init": {
      connection = new ReadConnection((data as { dbPath: string }).dbPath);
      return;
    }
    case "warm": {
      // Opening the connection and reading the schema here is what makes the
      // first real request after startup as fast as later ones.
      void connection
        ?.use((db) => db.query("SELECT 1 FROM schema_migrations LIMIT 1").get())
        .catch(() => {
          // A failure here resurfaces on the first real read, with a response.
        });
      return;
    }
    case "run": {
      const { id, name, args } = data as { id: number; name: unknown; args: unknown };
      void run(id, name, args);
      return;
    }
    case "reload-statistics": {
      connection?.reloadStatistics();
      return;
    }
    case "close": {
      // Removing the listener lets Bun drain the worker event loop once the
      // native connection is closed; exiting naturally avoids racing the
      // parent's teardown against SQLite finalization.
      self.removeEventListener("message", onMessage);
      connection?.close();
      connection = null;
      return;
    }
  }
});
