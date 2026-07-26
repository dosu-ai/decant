// Cross-message linkage diagnostics over a parsed session. Pure and
// print-free: parsers append the result to ParsedSession.issues so ingest
// stores one complete diagnostic set per source file.
import type { Issue, NormalizedSession } from "./model.ts";

export function linkageIssues(session: NormalizedSession): Issue[] {
  const issues: Issue[] = [];
  const useIds = new Map<string, string | null>();
  for (const message of session.messages) {
    for (const block of message.blocks) {
      if (block.blockType !== "tool_use" || block.toolUseId == null) {
        continue;
      }
      if (useIds.has(block.toolUseId)) {
        issues.push({
          code: "duplicate_tool_use_id",
          lineNo: null,
          error: `tool_use id "${block.toolUseId}" appears more than once (${block.toolName ?? "unknown tool"})`,
          rawLine: null,
        });
      }
      useIds.set(block.toolUseId, block.toolName);
    }
  }
  const answered = new Set<string>();
  for (const message of session.messages) {
    for (const block of message.blocks) {
      if (block.blockType !== "tool_result" || block.toolUseId == null) {
        continue;
      }
      if (!useIds.has(block.toolUseId)) {
        issues.push({
          code: "orphan_tool_result",
          lineNo: null,
          error: `tool_result references tool_use id "${block.toolUseId}" absent from the session`,
          rawLine: null,
        });
      }
      if (answered.has(block.toolUseId)) {
        issues.push({
          code: "duplicate_tool_result",
          lineNo: null,
          error: `tool_use id "${block.toolUseId}" received more than one result`,
          rawLine: null,
        });
      }
      answered.add(block.toolUseId);
    }
  }
  return issues;
}
