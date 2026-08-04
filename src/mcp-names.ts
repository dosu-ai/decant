/**
 * Display names for MCP server slugs.
 *
 * The same logical server reaches the archive under three slug namespaces: a
 * bare id from a project or user `.mcp.json` (`dosu`), a claude.ai connector
 * (`claude_ai_Dosu`), and a plugin-bundled server (`plugin_posthog_posthog`).
 * Stripping the namespace prefix reads far better, but it is lossy: distinct
 * registrations collapse onto one label, and two rows sharing a name read as a
 * duplicate-row bug rather than as the two real registrations they are.
 *
 * So `formatMcpServer` is only safe where nothing else in view formats to the
 * same string. Wherever sibling servers are on screen together, build labels
 * with `mcpServerLabels`, which keeps the short name where it is unambiguous
 * and appends provenance only where it is not.
 *
 * Display only. Filter values, hrefs, API payloads, and stored rows keep the
 * raw slug -- it is the identity, and the pretty name is not unique.
 */

const CONNECTOR_PREFIX = /^claude_ai_/;
const PLUGIN_PREFIX = /^plugin_([^_]+)_/;
const SEGMENT_SEPARATOR = /[-_]+/;
/** Servers are occasionally registered under a generated id rather than a
 * name. Word-splitting one produces title-cased hex noise, so leave it whole:
 * the raw id is at least recognizable and matches what a reader can grep. */
const OPAQUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strip at most one namespace prefix, longest-standing convention first. */
function stripNamespace(raw: string): string {
  if (CONNECTOR_PREFIX.test(raw)) {
    return raw.replace(CONNECTOR_PREFIX, "");
  }
  if (PLUGIN_PREFIX.test(raw)) {
    return raw.replace(PLUGIN_PREFIX, "");
  }
  return raw;
}

/** Where a registration came from, as a short phrase that disambiguates two
 * servers sharing a display name. */
export function mcpServerOrigin(raw: string): string {
  if (CONNECTOR_PREFIX.test(raw)) {
    return "connector";
  }
  const plugin = PLUGIN_PREFIX.exec(raw)?.[1];
  if (plugin == null) {
    return "local";
  }
  // A plugin usually names its server after itself (`plugin_posthog_posthog`),
  // and "Posthog (posthog plugin)" only stutters. Name the plugin when it adds
  // something the display name does not already say.
  return plugin.toLowerCase() === stripNamespace(raw).toLowerCase() ? "plugin" : `${plugin} plugin`;
}

/** Short display name for one slug, ignoring every other server in view.
 * Lossy by construction -- prefer `mcpServerLabels` when rendering a set. */
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

/** Display labels for a whole set of slugs, keyed by raw slug. A name shared
 * by two or more distinct slugs gains its origin, so `dosu` and
 * `claude_ai_Dosu` render as "Dosu (local)" and "Dosu (connector)" instead of
 * two rows both reading "Dosu". Unambiguous names are left short. */
export function mcpServerLabels(raws: Iterable<string | null | undefined>): Map<string, string> {
  const shortNames = new Map<string, string>();
  const uses = new Map<string, number>();
  for (const raw of raws) {
    // Count distinct slugs, not rows: the same slug twice is not a collision.
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

/** Look a slug up in `mcpServerLabels` output, falling back to the short name
 * for a slug that was not part of the set the labels were built from. */
export function mcpServerLabel(
  labels: Map<string, string>,
  raw: string | null | undefined,
): string {
  if (raw == null || raw === "") {
    return "";
  }
  return labels.get(raw) ?? formatMcpServer(raw);
}
