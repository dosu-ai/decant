import { diffLines, diffWordsWithSpace } from "diff";
import { classifyTool } from "../tools.ts";

export const TRANSCRIPT_COLLAPSE_LINES = 15;
export const TRANSCRIPT_COLLAPSE_BYTES = 2 * 1024;
export const TRANSCRIPT_PLAINTEXT_BYTES = 50 * 1024;
export const TRANSCRIPT_DIFF_BYTES = 50 * 1024;
const UTF8_ENCODER = new TextEncoder();

export const transcriptLanguages = [
  "bash",
  "diff",
  "go",
  "javascript",
  "json",
  "jsx",
  "markdown",
  "python",
  "rust",
  "sql",
  "tsx",
  "typescript",
  "yaml",
] as const;

export type TranscriptLanguage = (typeof transcriptLanguages)[number];
export type TranscriptTheme = "dark" | "light";

export interface TranscriptContentMeasure {
  byteLength: number;
  lineCount: number;
  shouldCollapse: boolean;
  shouldHighlight: boolean;
}

export interface CollapsedTranscriptText extends TranscriptContentMeasure {
  hiddenLineCount: number;
  omittedBytes: number;
  preview: string;
}

export interface MarkdownLinkBehavior {
  external: boolean;
  href: string | undefined;
  rel?: "noopener noreferrer";
  target?: "_blank";
}

export interface EmbeddedAttachmentSummary {
  byteLength: number;
  kind: "image";
  mediaType: string;
}

export interface ToolDiffPart {
  kind: "added" | "removed" | "unchanged";
  value: string;
}

export interface ToolDiffLine {
  kind: "added" | "removed" | "unchanged";
  newLine: number | null;
  oldLine: number | null;
  parts: ToolDiffPart[];
  text: string;
}

export type TranscriptToolPresentation =
  | {
      kind: "shell";
      arguments: string;
      caption: string | null;
      command: string;
      language: "bash";
      path: null;
    }
  | {
      kind: "file";
      arguments: string;
      content: string | null;
      language: TranscriptLanguage | null;
      operation: "read" | "write";
      path: string | null;
    }
  | {
      kind: "edit";
      arguments: string;
      diff: ToolDiffLine[];
      language: TranscriptLanguage | null;
      path: string | null;
    }
  | {
      kind: "search";
      arguments: string;
      language: null;
      path: string | null;
      pattern: string | null;
      searchKind: "glob" | "grep";
    }
  | {
      kind: "json";
      arguments: string;
      language: "json";
      path: string | null;
      source: "mcp" | "other";
    };

const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

const EXTENSION_LANGUAGES: Readonly<Record<string, TranscriptLanguage>> = {
  bash: "bash",
  cjs: "javascript",
  cts: "typescript",
  diff: "diff",
  go: "go",
  js: "javascript",
  json: "json",
  jsonl: "json",
  jsx: "jsx",
  markdown: "markdown",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mts: "typescript",
  patch: "diff",
  py: "python",
  pyi: "python",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const LANGUAGE_ALIASES: Readonly<Record<string, TranscriptLanguage>> = {
  bash: "bash",
  diff: "diff",
  go: "go",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  markdown: "markdown",
  md: "markdown",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  sh: "bash",
  shell: "bash",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export function normalizeTranscriptLanguage(
  language: string | null | undefined,
): TranscriptLanguage | null {
  if (language == null) {
    return null;
  }
  return LANGUAGE_ALIASES[language.trim().toLowerCase()] ?? null;
}

/**
 * Recognizes only the embedded image shape emitted by Claude transcripts.
 * The archive keeps the complete canonical JSON; this summary deliberately
 * excludes the base64 payload so the UI never places megabytes of encoded
 * image data into the DOM.
 */
export function embeddedAttachmentSummary(
  blockType: string,
  text: string | null | undefined,
): EmbeddedAttachmentSummary | null {
  if (blockType !== "other" || text == null || text === "") {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (
    record.type !== "image" ||
    source == null ||
    typeof source !== "object" ||
    Array.isArray(source)
  ) {
    return null;
  }
  const sourceRecord = source as Record<string, unknown>;
  const mediaType = sourceRecord.media_type;
  const data = sourceRecord.data;
  if (
    sourceRecord.type !== "base64" ||
    typeof mediaType !== "string" ||
    !/^image\/[a-z0-9.+-]+$/i.test(mediaType) ||
    typeof data !== "string" ||
    data.length === 0 ||
    !/^[a-z0-9+/]*={0,2}$/i.test(data)
  ) {
    return null;
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return {
    byteLength: Math.max(0, Math.floor((data.length * 3) / 4) - padding),
    kind: "image",
    mediaType,
  };
}

export function languageForPath(path: string | null | undefined): TranscriptLanguage | null {
  if (path == null) {
    return null;
  }
  const cleanPath = path.trim().split(/[?#]/, 1)[0] ?? "";
  const filename = cleanPath.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (filename === "bashrc" || filename === "zshrc") {
    return "bash";
  }
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) {
    return null;
  }
  return EXTENSION_LANGUAGES[filename.slice(dot + 1)] ?? null;
}

export function pathForTool(
  toolName: string | null | undefined,
  toolInput: string | null | undefined,
): string | null {
  const input = parseToolInput(toolInput);
  if (input == null) {
    return null;
  }
  for (const key of PATH_KEYS) {
    const value = stringValue(input, key);
    if (value != null) {
      return value;
    }
  }
  const baseName = toolBaseName(toolName);
  if (baseName.includes("glob") || baseName.includes("grep")) {
    return stringValue(input, "directory") ?? stringValue(input, "cwd");
  }
  return null;
}

export function languageForTool(
  toolName: string | null | undefined,
  toolInput: string | null | undefined,
): TranscriptLanguage | null {
  if (toolName == null || toolName === "") {
    return languageForPath(pathForTool(toolName, toolInput));
  }
  const classified = classifyTool(toolName);
  if (classified.kind === "mcp") {
    return "json";
  }
  const baseName = toolBaseName(toolName);
  if (
    baseName === "bash" ||
    baseName === "shell" ||
    baseName.includes("exec_command") ||
    baseName.includes("run_command")
  ) {
    return "bash";
  }
  return languageForPath(pathForTool(toolName, toolInput)) ?? (toolInput == null ? null : "json");
}

export function measureTranscriptContent(value: string): TranscriptContentMeasure {
  const byteLength = UTF8_ENCODER.encode(value).byteLength;
  const lineCount = transcriptLineCount(value);
  return {
    byteLength,
    lineCount,
    shouldCollapse: lineCount > TRANSCRIPT_COLLAPSE_LINES || byteLength > TRANSCRIPT_COLLAPSE_BYTES,
    shouldHighlight: byteLength <= TRANSCRIPT_PLAINTEXT_BYTES,
  };
}

export function collapseTranscriptText(value: string): CollapsedTranscriptText {
  const measure = measureTranscriptContent(value);
  if (!measure.shouldCollapse) {
    return {
      ...measure,
      hiddenLineCount: 0,
      omittedBytes: 0,
      preview: value,
    };
  }

  const lines = value.split(/\r\n|\r|\n/);
  const preview = truncateUtf8(
    lines.slice(0, TRANSCRIPT_COLLAPSE_LINES).join("\n"),
    TRANSCRIPT_COLLAPSE_BYTES,
  );
  const previewBytes = UTF8_ENCODER.encode(preview).byteLength;
  return {
    ...measure,
    hiddenLineCount: Math.max(0, measure.lineCount - transcriptLineCount(preview)),
    omittedBytes: Math.max(0, measure.byteLength - previewBytes),
    preview,
  };
}

export function transcriptCollapseLabel(value: CollapsedTranscriptText): string {
  if (!value.shouldCollapse) {
    return "";
  }
  if (value.hiddenLineCount > 0) {
    return `Show ${value.hiddenLineCount} more ${value.hiddenLineCount === 1 ? "line" : "lines"}`;
  }
  return "Show full result";
}

/**
 * Markdown links are transcript data, not trusted application links. Relative
 * paths and fragments stay in-app; http(s) and mailto links require an explicit
 * user click and open without an opener. Active-content and file URLs are
 * dropped. Markdown images are disabled in the React renderer so rendering a
 * transcript never causes an outbound request.
 */
export function markdownLinkBehavior(href: string | null | undefined): MarkdownLinkBehavior {
  const safeHref = safeMarkdownUrl(href);
  if (safeHref == null) {
    return { external: false, href: undefined };
  }
  const external = /^(?:https?:|mailto:|\/\/)/i.test(safeHref);
  return external
    ? {
        external: true,
        href: safeHref,
        rel: "noopener noreferrer",
        target: "_blank",
      }
    : { external: false, href: safeHref };
}

export function safeMarkdownUrl(value: string | null | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const url = value.trim();
  if (url === "") {
    return undefined;
  }
  const colon = url.indexOf(":");
  const boundary = [url.indexOf("/"), url.indexOf("?"), url.indexOf("#")]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), Number.POSITIVE_INFINITY);
  if (colon < 0 || colon > boundary) {
    return url;
  }
  return /^(?:https?|mailto):/i.test(url) ? url : undefined;
}

export function presentationForTool(
  toolName: string | null | undefined,
  toolInput: string | null | undefined,
): TranscriptToolPresentation {
  const argumentsText = prettyToolInput(toolInput);
  const input = parseToolInput(toolInput);
  const baseName = toolBaseName(toolName);
  const path = pathForTool(toolName, toolInput);
  const language = languageForPath(path);
  if (toolName != null && classifyTool(toolName).kind === "mcp") {
    return {
      kind: "json",
      arguments: argumentsText,
      language: "json",
      path,
      source: "mcp",
    };
  }

  if (
    baseName === "bash" ||
    baseName === "shell" ||
    baseName.includes("exec_command") ||
    baseName.includes("run_command")
  ) {
    return {
      kind: "shell",
      arguments: argumentsText,
      caption: stringValue(input, "description"),
      command:
        stringValue(input, "command") ??
        stringValue(input, "cmd") ??
        stringValue(input, "script") ??
        argumentsText,
      language: "bash",
      path: null,
    };
  }

  if (baseName === "read" || baseName.endsWith("_read") || baseName.includes("read_file")) {
    return {
      kind: "file",
      arguments: argumentsText,
      content: null,
      language,
      operation: "read",
      path,
    };
  }

  if (baseName === "write" || baseName.endsWith("_write") || baseName.includes("write_file")) {
    return {
      kind: "file",
      arguments: argumentsText,
      content: stringValue(input, "content") ?? stringValue(input, "file_text"),
      language,
      operation: "write",
      path,
    };
  }

  if (baseName === "edit" || baseName.endsWith("_edit") || baseName.includes("edit_file")) {
    const oldText =
      stringValue(input, "old_string") ??
      stringValue(input, "old_text") ??
      stringValue(input, "before") ??
      "";
    const newText =
      stringValue(input, "new_string") ??
      stringValue(input, "new_text") ??
      stringValue(input, "after") ??
      "";
    return {
      kind: "edit",
      arguments: argumentsText,
      diff: createToolDiff(oldText, newText),
      language,
      path,
    };
  }

  if (baseName.includes("grep") || baseName.includes("glob")) {
    return {
      kind: "search",
      arguments: argumentsText,
      language: null,
      path,
      pattern:
        stringValue(input, "pattern") ?? stringValue(input, "query") ?? stringValue(input, "glob"),
      searchKind: baseName.includes("glob") ? "glob" : "grep",
    };
  }

  return {
    kind: "json",
    arguments: argumentsText,
    language: "json",
    path,
    source: toolName != null && classifyTool(toolName).kind === "mcp" ? "mcp" : "other",
  };
}

export function summarizeToolResult(
  toolName: string | null | undefined,
  result: string | null | undefined,
): string | null {
  if (result == null || result.trim() === "") {
    return null;
  }
  const baseName = toolBaseName(toolName);
  if (!baseName.includes("grep") && !baseName.includes("glob")) {
    return null;
  }
  const matches = result.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "").length;
  return `${matches} ${baseName.includes("glob") ? "paths" : "matches"}`;
}

export function createToolDiff(oldText: string, newText: string): ToolDiffLine[] {
  if (
    UTF8_ENCODER.encode(oldText).byteLength + UTF8_ENCODER.encode(newText).byteLength >
    TRANSCRIPT_DIFF_BYTES
  ) {
    return [];
  }
  const changes = diffLines(oldText, newText);
  const rows: ToolDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (change == null) {
      continue;
    }
    const next = changes[index + 1];
    if (change.removed === true && next?.added === true) {
      const removedLines = contentLines(change.value);
      const addedLines = contentLines(next.value);
      const pairs = Math.max(removedLines.length, addedLines.length);
      for (let pair = 0; pair < pairs; pair += 1) {
        const removed = removedLines[pair];
        const added = addedLines[pair];
        const wordDiff = diffWordsWithSpace(removed ?? "", added ?? "");
        if (removed != null) {
          rows.push({
            kind: "removed",
            newLine: null,
            oldLine: oldLine++,
            parts: wordDiff
              .filter((part) => part.added !== true)
              .map((part) => ({
                kind: part.removed === true ? "removed" : "unchanged",
                value: part.value,
              })),
            text: removed,
          });
        }
        if (added != null) {
          rows.push({
            kind: "added",
            newLine: newLine++,
            oldLine: null,
            parts: wordDiff
              .filter((part) => part.removed !== true)
              .map((part) => ({
                kind: part.added === true ? "added" : "unchanged",
                value: part.value,
              })),
            text: added,
          });
        }
      }
      index += 1;
      continue;
    }

    for (const line of contentLines(change.value)) {
      const kind =
        change.added === true ? "added" : change.removed === true ? "removed" : "unchanged";
      rows.push({
        kind,
        newLine: kind === "removed" ? null : newLine++,
        oldLine: kind === "added" ? null : oldLine++,
        parts: [{ kind, value: line }],
        text: line,
      });
    }
  }
  return rows;
}

function parseToolInput(value: string | null | undefined): Record<string, unknown> | null {
  if (value == null || value.trim() === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function prettyToolInput(value: string | null | undefined): string {
  if (value == null || value === "") {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function stringValue(input: Record<string, unknown> | null, key: string): string | null {
  const value = input?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function toolBaseName(toolName: string | null | undefined): string {
  if (toolName == null) {
    return "";
  }
  const baseName = classifyTool(toolName).baseName;
  return baseName.trim().toLowerCase();
}

function transcriptLineCount(value: string): number {
  if (value === "") {
    return 0;
  }
  const lines = value.split(/\r\n|\r|\n/).length;
  return /(?:\r\n|\r|\n)$/.test(value) ? Math.max(0, lines - 1) : lines;
}

function contentLines(value: string): string[] {
  if (value === "") {
    return [];
  }
  const lines = value.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (UTF8_ENCODER.encode(value).byteLength <= maxBytes) {
    return value;
  }
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = UTF8_ENCODER.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}
