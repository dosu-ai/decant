type ServerEvent = { type: string };

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

interface EventClient {
  send(event: ServerEvent): void;
  close(): void;
}

export function eventStream(heartbeatMs = 5_000): Response {
  const encoder = new TextEncoder();
  let client: EventClient | null = null;
  let heartbeat: Timer | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ServerEvent): void =>
        controller.enqueue(encoder.encode(formatSse(event)));
      const close = (): void => {
        if (heartbeat != null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (client != null) {
          eventClients.delete(client);
          client = null;
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
    cancel() {
      client?.close();
    },
  });
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
