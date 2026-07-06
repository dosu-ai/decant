// Pure helpers behind the virtualized sessions table. Kept free of React and
// API types so the row-window decisions stay unit-testable.

export type FlatSessionRow<T> = {
  depth: number;
  session: T;
};

/**
 * Flattens the session tree into the exact row list the table renders:
 * each session followed by its subagent rows only while it is expanded,
 * depth-first, with the nesting depth recorded for indentation.
 */
export function flattenSessionRows<T extends { id: number; subagents?: T[] }>(
  sessions: readonly T[],
  expanded: ReadonlySet<number>,
  depth = 0,
): FlatSessionRow<T>[] {
  const rows: FlatSessionRow<T>[] = [];
  for (const session of sessions) {
    rows.push({ depth, session });
    if (expanded.has(session.id)) {
      rows.push(...flattenSessionRows(session.subagents ?? [], expanded, depth + 1));
    }
  }
  return rows;
}

/**
 * Spacer heights that keep the table's scroll height honest while only the
 * virtual window's rows are in the DOM. Virtual item offsets include the
 * virtualizer's scrollMargin; totalSize does not.
 */
export function virtualTablePadding({
  items,
  scrollMargin,
  totalSize,
}: {
  items: readonly { end: number; start: number }[];
  scrollMargin: number;
  totalSize: number;
}): { bottom: number; top: number } {
  const first = items[0];
  const last = items[items.length - 1];
  if (first == null || last == null) {
    return { bottom: 0, top: 0 };
  }
  return {
    bottom: Math.max(0, totalSize - (last.end - scrollMargin)),
    top: Math.max(0, first.start - scrollMargin),
  };
}
