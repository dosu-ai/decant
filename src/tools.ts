import type { ToolKind } from "./model.ts";

export interface ClassifiedTool {
  kind: ToolKind;
  mcpServer: string | null;
  baseName: string;
}

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

export function headScalars(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  let head = "";
  let taken = 0;
  for (const ch of s) {
    if (taken === max) {
      break;
    }
    head += ch;
    taken += 1;
  }
  return head;
}

export function preview(s: string, max: number): string {
  const head = headScalars(s, max);
  return head.length === s.length ? s : `${head}…`;
}

export function previewHeadTail(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  let scalars = 0;
  for (const _ of s) {
    scalars += 1;
  }
  if (scalars <= max) {
    return s;
  }
  const tailLen = Math.floor((max * 2) / 5);
  const headLen = max - tailLen;
  const omitted = scalars - headLen - tailLen;
  let head = "";
  let taken = 0;
  for (const ch of s) {
    if (taken === headLen) {
      break;
    }
    head += ch;
    taken += 1;
  }
  const tail = tailLen === 0 ? "" : [...s.slice(-tailLen * 2)].slice(-tailLen).join("");
  return `${head}\n[… ${omitted} chars omitted …]\n${tail}`;
}

const PREVIEW_ELISION = /\n\[… (\d+) chars omitted …\]\n/;

export function previewOmittedCount(value: string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const match = PREVIEW_ELISION.exec(value);
  return match?.[1] == null ? null : Number(match[1]);
}
