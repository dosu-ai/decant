import { errorResponse } from "./http.ts";

type ServerEvent = { type: string };

/** One stream per tab; browsers allow six connections per origin. */
export const MAX_EVENT_CLIENTS = 32;

/** Kept small because a closed stream holds its queue until the client reads. */
const EVENT_STREAM_HIGH_WATER_BYTES = 64 * 1024;

/** Past this the stream ends rather than coalescing, so `sync` and `error` are
 * never dropped; EventSource reconnects and the UI refetches. */
export const MAX_EVENT_BACKLOG_BYTES = 1024 * 1024;

const eventClients = new Set<EventClient>();

export function publishServerEvent<T extends ServerEvent>(event: T): void {
  for (const client of [...eventClients]) {
    try {
      client.send(event);
    } catch {
      client.close();
    }
  }
}

/** Open event streams, for tests. */
export function eventClientCount(): number {
  return eventClients.size;
}

interface EventClient {
  send(event: ServerEvent): void;
  close(): void;
}

export function eventStream(heartbeatMs = 5_000): Response {
  if (eventClients.size >= MAX_EVENT_CLIENTS) {
    return errorResponse(
      "server_busy",
      "Too many event streams are open. Close another Decant tab or try again.",
      { retryable: true },
      503,
    );
  }
  const encoder = new TextEncoder();
  let client: EventClient | null = null;
  let heartbeat: Timer | null = null;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const flush = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    while (pending.length > 0 && (controller.desiredSize ?? 0) > 0) {
      const chunk = pending.shift() as Uint8Array;
      pendingBytes -= chunk.byteLength;
      controller.enqueue(chunk);
    }
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const close = (): void => {
          if (heartbeat != null) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          if (client != null) {
            eventClients.delete(client);
            client = null;
          }
          pending = [];
          pendingBytes = 0;
        };
        // Slow readers drain `pending` in order through pull().
        const send = (event: ServerEvent): void => {
          const chunk = encoder.encode(formatSse(event));
          pending.push(chunk);
          pendingBytes += chunk.byteLength;
          flush(controller);
          if (pendingBytes > MAX_EVENT_BACKLOG_BYTES) {
            close();
            controller.close();
          }
        };
        client = { send, close };
        eventClients.add(client);
        send({ type: "hello", timestamp: new Date().toISOString() } as ServerEvent);
        heartbeat = setInterval(() => {
          if (client == null) {
            return;
          }
          try {
            send({ type: "ping", timestamp: new Date().toISOString() } as ServerEvent);
          } catch {
            close();
          }
        }, heartbeatMs);
      },
      pull(controller) {
        flush(controller);
      },
      cancel() {
        client?.close();
      },
    },
    { highWaterMark: EVENT_STREAM_HIGH_WATER_BYTES, size: (chunk) => chunk?.byteLength ?? 0 },
  );
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function formatSse(event: ServerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
