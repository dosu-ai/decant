export interface SliceLoadFailure<Slice extends string> {
  slice: Slice;
  reason: unknown;
}

export interface CollectedSliceResults<Slice extends string, Data extends object> {
  data: Partial<Data>;
  loaded: Slice[];
  failures: SliceLoadFailure<Slice>[];
}

export function dateScopedSliceStatus(
  loadedKey: string | undefined,
  failed: boolean,
  dateQuery: string,
): "ready" | "failed" | "loading" {
  if (loadedKey?.startsWith(`${dateQuery}|`)) {
    return "ready";
  }
  return failed ? "failed" : "loading";
}

/** Publish each request as it settles so a slow analytics slice cannot hold
 * back data that is already available to render. */
export async function loadSlicesIndependently<Slice extends string, Data extends object>(
  slices: readonly Slice[],
  load: (slice: Slice) => Promise<Partial<Data>>,
  onSettled: (slice: Slice, result: PromiseSettledResult<Partial<Data>>) => void,
): Promise<void> {
  await Promise.allSettled(
    slices.map((slice) =>
      Promise.resolve()
        .then(() => load(slice))
        .then(
          (value) => onSettled(slice, { status: "fulfilled", value }),
          (reason: unknown) => onSettled(slice, { status: "rejected", reason }),
        ),
    ),
  );
}

export function collectSliceResults<Slice extends string, Data extends object>(
  slices: readonly Slice[],
  results: readonly PromiseSettledResult<Partial<Data>>[],
): CollectedSliceResults<Slice, Data> {
  const data: Partial<Data> = {};
  const loaded: Slice[] = [];
  const failures: SliceLoadFailure<Slice>[] = [];

  for (const [index, slice] of slices.entries()) {
    const result = results[index];
    if (result?.status === "fulfilled") {
      Object.assign(data, result.value);
      loaded.push(slice);
    } else {
      failures.push({
        slice,
        reason: result?.status === "rejected" ? result.reason : new Error("missing slice result"),
      });
    }
  }

  return { data, loaded, failures };
}
