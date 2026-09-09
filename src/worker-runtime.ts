interface WorkerErrorEventLike {
  error: unknown;
  message?: string;
}

/** Bun emits compiled TypeScript entrypoints with `.js` names inside the
 * standalone module graph, while source execution loads the adjacent `.ts`. */
export function workerUrl(sourceName: string): URL {
  const embedded = import.meta.url.startsWith("file:///$bunfs/");
  const entryName = embedded ? sourceName.replace(/\.ts$/, ".js") : sourceName;
  return new URL(`./${entryName}`, import.meta.url);
}

/** Preserve a worker's real exception when Bun provides one, but fall back to
 * ErrorEvent.message and then any non-null payload before using a stable label.
 * Resolution failures in a compiled executable can emit an ErrorEvent whose
 * `error` field is null. */
export function workerError(event: WorkerErrorEventLike, fallback: string): Error {
  if (event.error instanceof Error) {
    return event.error;
  }
  const message = event.message?.trim();
  if (message != null && message !== "") {
    return new Error(message);
  }
  if (event.error != null) {
    return new Error(String(event.error));
  }
  return new Error(fallback);
}
