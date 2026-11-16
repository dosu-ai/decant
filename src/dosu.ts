export const CONFIRMED_DOSU_SERVER_IDS = ["dosu", "claude_ai_Dosu"] as const;

const confirmedDosuServerIds = new Set<string>(CONFIRMED_DOSU_SERVER_IDS);

export function isDosuServer(server: string | null | undefined): boolean {
  return server != null && confirmedDosuServerIds.has(server);
}
