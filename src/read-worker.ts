import { ReadConnection } from "./read-connection.ts";
import { executeReadOp, isReadOpName, type ReadOpArgs } from "./server/read-ops.ts";

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
      executeReadOp(db, name, args as ReadOpArgs<typeof name>),
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
      void connection
        ?.use((db) => db.query("SELECT 1 FROM schema_migrations LIMIT 1").get())
        .catch(() => {});
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
      self.removeEventListener("message", onMessage);
      connection?.close();
      connection = null;
      return;
    }
  }
});
