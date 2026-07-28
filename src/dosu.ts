/**
 * Canonical MCP server IDs that prove a session used Dosu.
 *
 * Keep this exact: transcript text, repository ownership, and arbitrary MCP
 * usage are not provenance. These names were confirmed against current Claude
 * and Codex configuration plus normalized rows in a real decant archive.
 */
export const CONFIRMED_DOSU_SERVER_IDS = ["dosu", "claude_ai_Dosu"] as const;

const confirmedDosuServerIds = new Set<string>(CONFIRMED_DOSU_SERVER_IDS);

export function isDosuServer(server: string | null | undefined): boolean {
  return server != null && confirmedDosuServerIds.has(server);
}
