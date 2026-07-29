import type { Database } from "bun:sqlite";
import { resolveSubagentParents } from "./ingest.ts";
import { materializeMissingSessionEconomics } from "./token-economics.ts";
import { resolveWorktreeRoots } from "./worktree.ts";

export function refreshDerivedMetadata(
  db: Database,
  options: { ignoreReadonly?: boolean } = {},
): void {
  for (const refresh of [
    resolveSubagentParents,
    resolveWorktreeRoots,
    materializeMissingSessionEconomics,
  ]) {
    try {
      refresh(db);
    } catch (error) {
      if (options.ignoreReadonly === true && isReadonlyDatabaseError(error)) {
        continue;
      }
      throw error;
    }
  }
}

function isReadonlyDatabaseError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("readonly database");
}
