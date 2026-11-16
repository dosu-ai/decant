import type { NavItem } from "./types.ts";

export const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      { key: "analytics", href: "/", label: "Analytics", icon: "chart" },
      { key: "insights", href: "/insights", label: "Insights", icon: "lightbulb" },
    ],
  },
  {
    label: "Browse",
    items: [
      { key: "sessions", href: "/sessions", label: "Sessions", icon: "sessions" },
      { key: "search", href: "/search", label: "Search", icon: "search" },
      { key: "projects", href: "/projects", label: "Projects", icon: "folder" },
      { key: "files", href: "/files", label: "Files", icon: "file" },
      { key: "tools", href: "/tools", label: "Tools & MCP", icon: "tools" },
    ],
  },
];

export const navItems: NavItem[] = navGroups.flatMap((group) => group.items);
