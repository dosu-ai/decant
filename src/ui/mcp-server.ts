const MCP_SERVER_PREFIXES = [/^claude_ai_/, /^plugin_[^_]+_/];

export function formatMcpServer(raw: string | null | undefined): string {
  if (raw == null || raw === "") {
    return "";
  }
  let rest = raw;
  for (const prefix of MCP_SERVER_PREFIXES) {
    if (prefix.test(rest)) {
      rest = rest.replace(prefix, "");
      break;
    }
  }
  return rest
    .split("_")
    .filter(Boolean)
    .map((segment) =>
      /[A-Z]/.test(segment) ? segment : segment.charAt(0).toUpperCase() + segment.slice(1),
    )
    .join(" ");
}
