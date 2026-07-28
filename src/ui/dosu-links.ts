type DosuLink =
  | "about"
  | "analytics_callout"
  | "insights_card"
  | "report_cta"
  | "report_footer"
  | "session_badge"
  | "sidebar";

const LINK_CONFIG: Record<
  DosuLink,
  { path: "" | "/for-agents"; medium: "app"; campaign: string; content: string }
> = {
  about: { path: "", medium: "app", campaign: "attribution", content: "about" },
  analytics_callout: {
    path: "/for-agents",
    medium: "app",
    campaign: "contextual_cta",
    content: "analytics_callout",
  },
  insights_card: {
    path: "/for-agents",
    medium: "app",
    campaign: "contextual_cta",
    content: "insights_card",
  },
  report_cta: {
    path: "/for-agents",
    medium: "app",
    campaign: "contextual_cta",
    content: "report_cta",
  },
  report_footer: {
    path: "",
    medium: "app",
    campaign: "attribution",
    content: "report_footer",
  },
  session_badge: {
    path: "/for-agents",
    medium: "app",
    campaign: "provenance",
    content: "session_badge",
  },
  sidebar: { path: "", medium: "app", campaign: "attribution", content: "sidebar" },
};

export function dosuLink(placement: DosuLink): string {
  const config = LINK_CONFIG[placement];
  const params = new URLSearchParams({
    utm_source: "decant",
    utm_medium: config.medium,
    utm_campaign: config.campaign,
    utm_content: config.content,
  });
  return `https://dosu.dev${config.path}?${params.toString()}`;
}
