import { describe, expect, test } from "bun:test";
import { workerError, workerUrl } from "../src/worker-runtime.ts";

test("workerUrl keeps TypeScript worker names during source execution", () => {
  expect(workerUrl("sync-worker.ts").pathname).toEndWith("/src/sync-worker.ts");
});

describe("workerError", () => {
  test("preserves a concrete worker exception", () => {
    const cause = new Error("worker exploded");
    expect(workerError({ error: cause, message: "ignored" }, "worker failed")).toBe(cause);
  });

  test("uses the ErrorEvent message when the exception is missing", () => {
    expect(workerError({ error: null, message: "module not found" }, "worker failed").message).toBe(
      "module not found",
    );
  });

  test("retains a non-Error exception payload when no message is available", () => {
    expect(workerError({ error: "worker exploded" }, "worker failed").message).toBe(
      "worker exploded",
    );
  });

  test("uses a stable fallback instead of stringifying null", () => {
    expect(workerError({ error: null, message: "" }, "worker failed").message).toBe(
      "worker failed",
    );
  });
});
