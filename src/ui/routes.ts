export type NavIcon = "chart" | "sessions" | "folder" | "search" | "lightbulb" | "tools" | "file";

export type NavItem = { key: string; href: string; label: string; icon: NavIcon };
export type NavSection = { label: string | null; items: NavItem[] };

// Analytics leads (overview-first); core archive next; analysis surfaces last.
// Search and Settings are topbar utilities, not primary navigation.
export const navSections: NavSection[] = [
  {
    label: null,
    items: [{ key: "analytics", href: "/analytics", label: "Analytics", icon: "chart" }],
  },
  {
    label: "Archive",
    items: [
      { key: "sessions", href: "/sessions", label: "Sessions", icon: "sessions" },
      { key: "projects", href: "/projects", label: "Projects", icon: "folder" },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { key: "insights", href: "/insights", label: "Insights", icon: "lightbulb" },
      { key: "tools", href: "/tools", label: "Tools & MCP", icon: "tools" },
      { key: "files", href: "/files", label: "Files", icon: "file" },
    ],
  },
];

export const navItems: NavItem[] = navSections.flatMap((section) => section.items);

export function pathOnly(path: string): string {
  return path.split("?", 1)[0] ?? "/";
}

export function activeRoute(path: string): string {
  const pathname = pathOnly(path);
  if (pathname === "/sessions" || pathname.startsWith("/sessions/")) {
    return "Sessions";
  }
  if (pathname === "/search") {
    return "Search";
  }
  if (pathname === "/settings") {
    return "Settings";
  }
  const match = navItems.find((item) => item.href === pathname);
  return match?.label ?? "Analytics";
}

export function activeRouteKey(path: string): string {
  const pathname = pathOnly(path);
  if (pathname === "/sessions" || pathname.startsWith("/sessions/")) {
    return "sessions";
  }
  if (pathname === "/search") {
    return "search";
  }
  if (pathname === "/settings") {
    return "settings";
  }
  return navItems.find((item) => item.href === pathname)?.key ?? "analytics";
}

export function titleFor(active: string): string {
  return active;
}
