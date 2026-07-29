export const DOSU_ANALYTICS_DISMISSAL_KEY = "decant-dosu-callout-dismissed";

export type DosuCtaRoute = "analytics" | "insights";

export function shouldShowDosuCta({
  dismissed = false,
  route,
}: {
  dismissed?: boolean;
  route: DosuCtaRoute;
}): boolean {
  return route === "insights" || !dismissed;
}
