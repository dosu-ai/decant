import type { FileRef } from "./enrich.ts";
import type { NormalizedBlock, NormalizedSession } from "./model.ts";
import { headScalars } from "./tools.ts";

export type Outcome = "completed" | "failed" | "abandoned";
export type WorkType = "debugging" | "feature" | "refactor" | "research" | "ops";

export function outcome(session: NormalizedSession): Outcome | null {
  const main = session.messages.filter(
    (message) => rawBoolean(message.raw, "isSidechain") !== true,
  );
  if (main.length === 0) {
    return null;
  }

  for (const message of [...main].reverse().slice(0, 3)) {
    if (
      message.blocks.some(
        (block) =>
          block.blockType === "text" &&
          (block.text ?? "").startsWith("[Request interrupted by user"),
      )
    ) {
      return "abandoned";
    }
  }

  const last = [...main]
    .reverse()
    .find(
      (message) =>
        message.role === "user" || message.role === "assistant" || message.role === "tool",
    );
  if (last == null) {
    return null;
  }

  if (last.role === "user") {
    return "abandoned";
  }
  if (last.role === "tool") {
    const isError = last.blocks.some(
      (block) => block.blockType === "tool_result" && block.isError === true,
    );
    return isError ? "failed" : "abandoned";
  }
  if (last.stopReason === "tool_use") {
    return "abandoned";
  }
  return "completed";
}

export function workType(session: NormalizedSession, refs: readonly FileRef[]): WorkType | null {
  const prompt = firstUserPrompt(session);
  if (prompt != null) {
    const keyword = keywordWorkType(prompt);
    if (keyword != null) {
      return keyword;
    }
  }
  return toolMixWorkType(session, refs);
}

function firstUserPrompt(session: NormalizedSession): string | null {
  for (const message of session.messages) {
    if (message.role !== "user") {
      continue;
    }
    for (const block of message.blocks) {
      if (block.blockType !== "text") {
        continue;
      }
      const text = block.text ?? "";
      if (
        text.trim() !== "" &&
        !text.startsWith("[Request interrupted by user") &&
        !text.includes("<command-name>")
      ) {
        return text.toLowerCase();
      }
    }
  }
  return null;
}

function keywordWorkType(prompt: string): WorkType | null {
  const head = headScalars(prompt, 400);
  const words = new Set(head.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== ""));
  const has = (keys: readonly string[]): boolean =>
    keys.some((key) => (key.includes(" ") ? head.includes(key) : words.has(key)));

  if (
    has([
      "fix",
      "fixes",
      "fixing",
      "fixed",
      "bug",
      "bugs",
      "fail",
      "fails",
      "failing",
      "failed",
      "failure",
      "error",
      "errors",
      "broken",
      "crash",
      "crashes",
      "crashing",
      "regression",
      "debug",
      "debugging",
    ])
  ) {
    return "debugging";
  }
  if (
    has([
      "refactor",
      "refactoring",
      "rename",
      "renaming",
      "simplify",
      "clean up",
      "cleanup",
      "reorganize",
      "extract",
    ])
  ) {
    return "refactor";
  }
  if (
    has([
      "research",
      "investigate",
      "compare",
      "should we",
      "look into",
      "evaluate",
      "explore whether",
    ])
  ) {
    return "research";
  }
  if (
    has([
      "deploy",
      "deploying",
      "install",
      "installing",
      "configure",
      "configuring",
      "release",
      "ci",
      "pipeline",
      "provision",
      "upgrade",
      "upgrading",
    ])
  ) {
    return "ops";
  }
  if (
    has([
      "implement",
      "implementing",
      "add",
      "adding",
      "build",
      "building",
      "create",
      "creating",
      "write a",
      "new feature",
      "support for",
    ])
  ) {
    return "feature";
  }
  return null;
}

function toolMixWorkType(session: NormalizedSession, refs: readonly FileRef[]): WorkType | null {
  const reads = refs.filter((ref) => ref.operation === "read").length;
  const mutations = refs.filter((ref) => ref.operation !== "read").length;
  const webSearches = session.messages
    .flatMap((message) => message.blocks)
    .filter(isWebSearch).length;

  if (mutations === 0 && (reads > 0 || webSearches > 0)) {
    return "research";
  }

  const writes = refs.filter((ref) => ref.operation === "write").length;
  const edits = refs.filter((ref) => ref.operation === "edit").length;
  if (writes > edits && writes > 0) {
    return "feature";
  }
  if (edits > 0) {
    return "feature";
  }
  return null;
}

function isWebSearch(block: NormalizedBlock): boolean {
  return (
    block.blockType === "web_search" ||
    (block.blockType === "tool_use" &&
      (block.toolName === "WebSearch" || block.toolName === "WebFetch"))
  );
}

function rawBoolean(raw: unknown, key: string): boolean | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}
