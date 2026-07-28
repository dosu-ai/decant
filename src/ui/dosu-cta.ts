export const DOSU_ANALYTICS_DISMISSAL_KEY = "decant-dosu-callout-dismissed";

export type DosuCtaRoute = "analytics" | "insights";
export type DosuSuggestions = "hide" | "show";

export function shouldShowDosuCta({
  dismissed = false,
  route,
  suggestions,
}: {
  dismissed?: boolean;
  route: DosuCtaRoute;
  suggestions: DosuSuggestions | null | undefined;
}): boolean {
  if (suggestions === "hide") {
    return false;
  }
  return route === "insights" || !dismissed;
}
