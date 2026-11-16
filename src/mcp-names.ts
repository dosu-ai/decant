const CONNECTOR_PREFIX = /^claude_ai_/;
const PLUGIN_PREFIX = /^plugin_([^_]+)_/;
const SEGMENT_SEPARATOR = /[-_]+/;
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stripNamespace(raw: string): string {
  if (CONNECTOR_PREFIX.test(raw)) {
    return raw.replace(CONNECTOR_PREFIX, "");
  }
  if (PLUGIN_PREFIX.test(raw)) {
    return raw.replace(PLUGIN_PREFIX, "");
  }
  return raw;
}

export function mcpServerOrigin(raw: string): string {
  if (CONNECTOR_PREFIX.test(raw)) {
    return "connector";
  }
  const plugin = PLUGIN_PREFIX.exec(raw)?.[1];
  if (plugin == null) {
    return "local";
  }
  return plugin.toLowerCase() === stripNamespace(raw).toLowerCase() ? "plugin" : `${plugin} plugin`;
}

export function formatMcpServer(raw: string | null | undefined): string {
  if (raw == null || raw === "") {
    return "";
  }
  const bare = stripNamespace(raw);
  if (OPAQUE_ID.test(bare)) {
    return bare;
  }
  return bare
    .split(SEGMENT_SEPARATOR)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function mcpServerLabels(raws: Iterable<string | null | undefined>): Map<string, string> {
  const shortNames = new Map<string, string>();
  const uses = new Map<string, number>();
  for (const raw of raws) {
    if (raw == null || raw === "" || shortNames.has(raw)) {
      continue;
    }
    const name = formatMcpServer(raw);
    shortNames.set(raw, name);
    uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const [raw, name] of shortNames) {
    labels.set(raw, (uses.get(name) ?? 0) > 1 ? `${name} (${mcpServerOrigin(raw)})` : name);
  }
  return labels;
}

export function mcpServerLabel(
  labels: Map<string, string>,
  raw: string | null | undefined,
): string {
  if (raw == null || raw === "") {
    return "";
  }
  return labels.get(raw) ?? formatMcpServer(raw);
}
