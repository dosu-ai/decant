import { describe, expect, test } from "bun:test";
import {
  activeRoute,
  activeRouteKey,
  type NavDestination,
  pathOnly,
  titleFor,
} from "../src/ui/navigation.ts";

// Mirrors the sidebar's own order: Overview first, then Browse.
const ITEMS: NavDestination[] = [
  { key: "analytics", href: "/analytics", label: "Analytics" },
  { key: "insights", href: "/insights", label: "Insights" },
  { key: "sessions", href: "/sessions", label: "Sessions" },
  { key: "search", href: "/search", label: "Search" },
  { key: "projects", href: "/projects", label: "Projects" },
  { key: "files", href: "/files", label: "Files" },
  { key: "tools", href: "/tools", label: "Tools & MCP" },
];

describe("route resolution", () => {
  test("the landing route is Analytics, not Sessions", () => {
    expect(activeRoute("/", ITEMS)).toBe("Analytics");
    expect(activeRouteKey("/", ITEMS)).toBe("analytics");
  });

  test("/analytics and / resolve to the same destination", () => {
    expect(activeRouteKey("/analytics", ITEMS)).toBe(activeRouteKey("/", ITEMS));
  });

  test("the session list keeps its own entry", () => {
    expect(activeRoute("/sessions", ITEMS)).toBe("Sessions");
    expect(activeRouteKey("/sessions", ITEMS)).toBe("sessions");
  });

  test("a transcript stays on Sessions rather than falling home", () => {
    // Regression guard: with "/" no longer meaning Sessions, a detail route that
    // missed its prefix check would light up Analytics while reading a session.
    expect(activeRoute("/sessions/42", ITEMS)).toBe("Sessions");
    expect(activeRouteKey("/sessions/42", ITEMS)).toBe("sessions");
  });

  test("every sidebar destination resolves to itself", () => {
    for (const item of ITEMS) {
      expect(activeRouteKey(item.href, ITEMS)).toBe(item.key);
      expect(activeRoute(item.href, ITEMS)).toBe(item.label);
    }
  });

  test("settings resolves without occupying a sidebar slot", () => {
    expect(activeRoute("/settings", ITEMS)).toBe("Settings");
    expect(activeRouteKey("/settings", ITEMS)).toBe("settings");
  });

  test("an unknown route falls back home", () => {
    expect(activeRoute("/nope", ITEMS)).toBe("Analytics");
    expect(activeRouteKey("/nope", ITEMS)).toBe("analytics");
  });

  test("a query string does not change the destination", () => {
    expect(activeRouteKey("/files?group=ext", ITEMS)).toBe("files");
    expect(activeRouteKey("/?from=2026-01-01", ITEMS)).toBe("analytics");
  });
});

describe("pathOnly", () => {
  test("strips the query and defaults to root", () => {
    expect(pathOnly("/files?group=ext")).toBe("/files");
    expect(pathOnly("/files")).toBe("/files");
    expect(pathOnly("")).toBe("/");
  });
});

describe("titleFor", () => {
  test("expands Sessions and passes everything else through", () => {
    expect(titleFor("Sessions")).toBe("Session Archive");
    expect(titleFor("Analytics")).toBe("Analytics");
    expect(titleFor("Tools & MCP")).toBe("Tools & MCP");
  });
});
