import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function cursorNativeRoot(root: string): string {
  return basename(root) === "projects" ? dirname(root) : root;
}

export function cursorNativeProjectsDir(root: string): string {
  if (basename(root) === "projects") {
    return root;
  }
  const projects = join(root, "projects");
  return existsSync(projects) ? projects : root;
}

export function cursorNativeChatsDir(root: string): string {
  return join(cursorNativeRoot(root), "chats");
}

export function cursorNativeTranscriptUuid(path: string): string | null {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const transcriptIndex = parts.lastIndexOf("agent-transcripts");
  const dirUuid = transcriptIndex >= 0 ? parts[transcriptIndex + 1] : null;
  const fileUuid = stripJsonl(parts.at(-1) ?? "");
  return dirUuid ?? (fileUuid === "" ? null : fileUuid);
}

function stripJsonl(name: string): string {
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
}
