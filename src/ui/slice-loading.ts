export interface SliceLoadFailure<Slice extends string> {
  slice: Slice;
  reason: unknown;
}

export interface CollectedSliceResults<Slice extends string, Data extends object> {
  data: Partial<Data>;
  loaded: Slice[];
  failures: SliceLoadFailure<Slice>[];
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
