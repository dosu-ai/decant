import { firstLine } from "./format.ts";
import type { SessionSummary } from "./types.ts";

export function sessionDisplayTitle(session: SessionSummary): string {
  return cleanSessionTitle(session.title) ?? session.source_session_id ?? "(untitled)";
}

export function cleanSessionTitle(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") {
    return null;
  }
  const text = stripAnsi(value).trim();
  if (isPermissionsText(text)) {
    return "Execution permissions";
  }
  if (/^<local-command-caveat>/i.test(text)) {
    return "Command context";
  }
  if (/^<local-command-std(?:out|err)>/i.test(text) || /^<local-command-output>/i.test(text)) {
    return "Command output";
  }
  if (/^<command-name>/i.test(text)) {
    return "Command context";
  }
  if (/^<teammate-message\b/i.test(text)) {
    return tagAttribute(text, "summary") ?? "Subagent request";
  }
  if (/^<environment_context>/i.test(text) || /^<user_info>/i.test(text)) {
    return "Environment context";
  }
  if (/^<system_reminder>/i.test(text)) {
    return "Agent context";
  }
  const query = cursorUserQuery(text);
  if (query != null) {
    return firstLine(query, 96);
  }
  const withoutMarkup = stripMarkupTags(text);
  if (withoutMarkup !== text && withoutMarkup !== "") {
    return firstLine(withoutMarkup.replace(/^Caveat:\s*/i, ""), 96);
  }
  const tag = text.match(/^<([a-z][a-z0-9_-]*)\b[^>]*>/i);
  if (tag == null) {
    return text;
  }
  const remainder = text.slice(tag[0].length).trim();
  if (remainder !== "" && !remainder.startsWith("<")) {
    return firstLine(remainder.replace(/^Caveat:\s*/i, ""), 96);
  }
  return readableTagLabel(tag[1] ?? "");
}

/** The Cursor CLI sends each prompt as `<timestamp>...</timestamp>` followed by
 * the text in `<user_query>`. Returns that text, or null for any other shape. */
export function cursorUserQuery(value: string): string | null {
  const match =
    /^\s*(?:<timestamp>[^<]*<\/timestamp>\s*)?<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/.exec(
      value,
    );
  return match?.[1] ? match[1] : null;
}

export function stripMarkupTags(value: string): string {
  return value
    .replace(/<\/?[a-z][a-z0-9_-]*\b[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripAnsi(value: string): string {
  const pattern = `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`;
  return value.replace(new RegExp(pattern, "g"), "");
}

export function isPermissionsText(value: string): boolean {
  return (
    /^<permissions instructions>/i.test(value) || value.includes("Filesystem sandboxing defines")
  );
}

export function tagAttribute(value: string, name: string): string | null {
  const pattern = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = value.match(pattern);
  return match == null ? null : (match[1] ?? match[2] ?? match[3] ?? null);
}

export function readableTagLabel(tag: string): string {
  switch (tag.toLowerCase()) {
    case "environment_context":
      return "Environment context";
    case "permissions":
    case "permissions-instructions":
    case "permissions_instructions":
      return "Execution permissions";
    default:
      return "Agent context";
  }
}

export function subagentDescriptor(session: SessionSummary): string {
  const kind = session.agent_type ?? "subagent";
  return session.agent_id != null ? `${kind} · ${session.agent_id}` : kind;
}
