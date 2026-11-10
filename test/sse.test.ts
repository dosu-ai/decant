import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import {
  eventClientCount,
  eventStream,
  MAX_EVENT_BACKLOG_BYTES,
  MAX_EVENT_CLIENTS,
  publishServerEvent,
} from "../src/server/sse.ts";
import { handleRequest } from "../src/server.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-sse-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

// Long enough that no heartbeat lands inside a test.
const QUIET_HEARTBEAT_MS = 60_000;
const BIG_EVENT_BYTES = 256 * 1024;

function bigEvent(n: number) {
  return { type: "archive_updated", reason: "test", n, padding: "x".repeat(BIG_EVENT_BYTES) };
}

function frames(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  return async (): Promise<{ event: string; data: Record<string, unknown> }> => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "";
        const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "{}");
        return { event, data };
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("stream ended");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}

function open(): ReadableStreamDefaultReader<Uint8Array> {
  const response = eventStream(QUIET_HEARTBEAT_MS);
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (reader == null) throw new Error("missing SSE body");
  return reader;
}

describe("event streams", () => {
  test("clients that read receive every event in order", async () => {
    const readers = [open(), open()];
    const next = readers.map(frames);
    try {
      for (const read of next) expect((await read()).event).toBe("hello");
      for (let n = 0; n < 5; n += 1) {
        publishServerEvent({ type: "archive_updated", reason: "test", n });
      }
      publishServerEvent({ type: "sync", reason: "manual", n: 5 });
      for (const read of next) {
        const seen = [];
        for (let n = 0; n < 6; n += 1) seen.push(await read());
        expect(seen.map((frame) => frame.data.n)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(seen.at(-1)?.event).toBe("sync");
      }
    } finally {
      for (const reader of readers) await reader.cancel();
    }
  });

  test("refuses streams past the client cap with a retryable 503", async () => {
    const before = eventClientCount();
    const readers = Array.from({ length: MAX_EVENT_CLIENTS - before }, open);
    try {
      expect(eventClientCount()).toBe(MAX_EVENT_CLIENTS);
      const refused = await handleRequest(new Request("http://127.0.0.1:3000/api/events"), {
        dbPath: join(workDir, "decant.db"),
      } as Config);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({ code: "server_busy", retryable: true });

      // A closed stream frees its slot.
      await readers.pop()?.cancel();
      readers.push(open());
      expect(eventClientCount()).toBe(MAX_EVENT_CLIENTS);
    } finally {
      for (const reader of readers) await reader.cancel();
    }
    expect(eventClientCount()).toBe(before);
  });

  test("a client that stops reading is dropped once its backlog passes the bound", async () => {
    const before = eventClientCount();
    const stalled = open();
    const healthy = open();
    const readHealthy = frames(healthy);
    try {
      await stalled.read();
      expect((await readHealthy()).event).toBe("hello");
      const underBound = Math.floor(MAX_EVENT_BACKLOG_BYTES / BIG_EVENT_BYTES) - 1;
      for (let n = 0; n < 32; n += 1) {
        publishServerEvent(bigEvent(n));
        expect((await readHealthy()).data.n).toBe(n);
        if (n < underBound) {
          // Still under the bound, so the stalled client keeps its stream.
          expect(eventClientCount()).toBe(before + 2);
        }
      }
      // The stalled stream was dropped while the reader stayed connected.
      expect(eventClientCount()).toBe(before + 1);
      // What it still delivers is what the stream held when it was dropped:
      // hello and one event. The held-back events were discarded.
      let delivered = 0;
      for (let chunk = await stalled.read(); !chunk.done; chunk = await stalled.read()) {
        delivered += chunk.value.byteLength;
      }
      expect(delivered).toBeGreaterThan(BIG_EVENT_BYTES);
      expect(delivered).toBeLessThan(2 * BIG_EVENT_BYTES);
    } finally {
      await healthy.cancel();
      await stalled.cancel().catch(() => {});
    }
    expect(eventClientCount()).toBe(before);
  });

  test("a socket that stops reading gets an ended response instead of a growing one", async () => {
    const before = eventClientCount();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => eventStream(QUIET_HEARTBEAT_MS),
    });
    const port = server.port;
    if (port == null) throw new Error("server has no port");
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    });
    let received = 0;
    let tail = "";
    let onData = (): void => {};
    socket.on("data", (data: Buffer) => {
      received += data.byteLength;
      tail = (tail + data.toString("latin1")).slice(-16);
      onData();
    });
    // Read the response head, then stop reading so the kernel buffers fill.
    socket.once("data", () => socket.pause());
    try {
      for (let i = 0; i < 100 && eventClientCount() === before; i += 1) await Bun.sleep(10);
      expect(eventClientCount()).toBe(before + 1);
      for (let n = 0; n < 32 && eventClientCount() > before; n += 1) {
        publishServerEvent(bigEvent(n));
        await Bun.sleep(5);
      }
      expect(eventClientCount()).toBe(before);
      // Once the client reads again the response ends with the last chunk, so
      // an EventSource reconnects. Most of the published 8 MiB never arrives.
      const ended = new Promise<void>((resolve) => {
        onData = () => {
          if (tail.endsWith("\r\n0\r\n\r\n")) resolve();
        };
      });
      socket.resume();
      await ended;
      expect(received).toBeLessThan(32 * BIG_EVENT_BYTES * 0.5);
    } finally {
      socket.destroy();
      server.stop(true);
    }
  });
});
