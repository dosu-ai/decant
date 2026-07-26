// Tool-name classification and text previews (port of tools.rs).
import type { ToolKind } from "./model.ts";

export interface ClassifiedTool {
  kind: ToolKind;
  mcpServer: string | null;
  baseName: string;
}

/** Classify a logged tool name into (kind, mcp_server, base_name).
 * MCP convention: `mcp__<server>__<base>` (base may itself contain `__`). */
export function classifyTool(name: string): ClassifiedTool {
  if (name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep !== -1) {
      return { kind: "mcp", mcpServer: rest.slice(0, sep), baseName: rest.slice(sep + 2) };
    }
    return { kind: "mcp", mcpServer: null, baseName: rest };
  }
  return { kind: "builtin", mcpServer: null, baseName: name };
}

/** First `max` characters of a string, with an ellipsis if truncated.
 * Counts Unicode scalars, never splitting surrogate pairs. */
export function preview(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) {
    return s;
  }
  return `${chars.slice(0, max).join("")}…`;
}

/** Head and tail of a string with an elision marker between them, for text
 * whose ending carries signal — tool errors report at the tail. Counts
 * Unicode scalars, never splitting surrogate pairs. `max` bounds the kept
 * scalars (60% head, 40% tail); the marker line is extra. */
export function previewHeadTail(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) {
    return s;
  }
  const tailLen = Math.floor((max * 2) / 5);
  const headLen = max - tailLen;
  const omitted = chars.length - headLen - tailLen;
  const head = chars.slice(0, headLen).join("");
  const tail = chars.slice(chars.length - tailLen).join("");
  return `${head}\n[… ${omitted} chars omitted …]\n${tail}`;
}
