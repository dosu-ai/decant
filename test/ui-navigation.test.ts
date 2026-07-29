import { describe, expect, test } from "bun:test";
import {
  activeRoute,
  activeRouteKey,
  documentTitleFor,
  isKnownRoute,
  type NavDestination,
  pathOnly,
  projectSessionsHref,
  sessionIncludesArchived,
  sessionProjectFilter,
  sessionsArchivedHref,
  titleFor,
} from "../src/ui/navigation.ts";

// Mirrors the sidebar's own order: Overview first, then Browse.
const ITEMS: NavDestination[] = [
  { key: "analytics", href: "/", label: "Analytics" },
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

  test("/analytics stays a working alias for the canonical /", () => {
    // The sidebar links to "/", so nothing generates "/analytics" any more.
    // Older links and bookmarks still have to land somewhere sensible.
    expect(activeRouteKey("/analytics", ITEMS)).toBe("analytics");
    expect(activeRoute("/analytics", ITEMS)).toBe("Analytics");
    expect(activeRouteKey("/analytics", ITEMS)).toBe(activeRouteKey("/", ITEMS));
  });

  test("the alias is a known route rather than a not-found fallback", () => {
    expect(isKnownRoute("/analytics", ITEMS)).toBe(true);
    expect(isKnownRoute("/nope", ITEMS)).toBe(false);
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

  test("malformed and overlong session paths are not session routes", () => {
    expect(isKnownRoute("/sessions/abc", ITEMS)).toBe(false);
    expect(isKnownRoute("/sessions/42/extra", ITEMS)).toBe(false);
    expect(activeRouteKey("/sessions/abc", ITEMS)).toBe("not-found");
    expect(activeRouteKey("/sessions/42/extra", ITEMS)).toBe("not-found");
  });

  test("report previews are known routes without occupying sidebar slots", () => {
    expect(activeRoute("/reports/analytics", ITEMS)).toBe("Analytics report");
    expect(activeRouteKey("/reports/analytics", ITEMS)).toBe("analytics-report");
    expect(activeRoute("/reports/session/42", ITEMS)).toBe("Session report");
    expect(activeRouteKey("/reports/session/42", ITEMS)).toBe("session-report");
    expect(isKnownRoute("/reports/session/abc", ITEMS)).toBe(false);
    expect(isKnownRoute("/reports/session/42/extra", ITEMS)).toBe(false);
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

  test("an unknown route resolves to the not-found view", () => {
    expect(activeRoute("/nope", ITEMS)).toBe("Not found");
    expect(activeRouteKey("/nope", ITEMS)).toBe("not-found");
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

describe("project session filters", () => {
  test("round-trips absolute project paths through the sessions URL", () => {
    const project = "/Users/dev/My Project";
    const href = projectSessionsHref(project);
    expect(href).toStartWith("/sessions?project=");
    expect(sessionProjectFilter(href)).toBe(project);
    expect(sessionProjectFilter("/sessions")).toBeNull();
    expect(sessionProjectFilter(`/projects?project=${encodeURIComponent(project)}`)).toBeNull();
  });
});

describe("archived session filters", () => {
  test("round-trips the toggle while preserving the active project", () => {
    const project = "/Users/dev/My Project";
    const filtered = projectSessionsHref(project);
    const withArchived = sessionsArchivedHref(filtered, true);

    expect(sessionIncludesArchived(withArchived)).toBe(true);
    expect(sessionProjectFilter(withArchived)).toBe(project);
    expect(sessionsArchivedHref(withArchived, false)).toBe(filtered);
  });

  test("does not treat the same query parameter on another route as a session filter", () => {
    expect(sessionIncludesArchived("/sessions?include_archived=true")).toBe(true);
    expect(sessionIncludesArchived("/projects?include_archived=true")).toBe(false);
    expect(sessionsArchivedHref("/sessions", false)).toBe("/sessions");
  });
});

describe("titleFor", () => {
  test("expands Sessions and passes everything else through", () => {
    expect(titleFor("Sessions")).toBe("Session Logs");
    expect(titleFor("Analytics")).toBe("Analytics");
    expect(titleFor("Tools & MCP")).toBe("Tools & MCP");
  });
});

describe("documentTitleFor", () => {
  test.each([
    ["/", "Analytics · Decant"],
    ["/analytics", "Analytics · Decant"],
    ["/sessions", "Sessions · Decant"],
    ["/sessions/42", "Session detail · Decant"],
    ["/sessions/abc", "Not found · Decant"],
    ["/sessions/42/extra", "Not found · Decant"],
    ["/reports/analytics", "Analytics report · Decant"],
    ["/reports/session/42", "Session report · Decant"],
    ["/reports/session/abc", "Not found · Decant"],
    ["/projects", "Projects · Decant"],
    ["/search", "Search · Decant"],
    ["/insights", "Insights · Decant"],
    ["/tools", "Tools & MCP · Decant"],
    ["/files", "File hotspots · Decant"],
    ["/settings", "Settings · Decant"],
    ["/nope", "Not found · Decant"],
  ])("maps %s to a privacy-safe browser title", (path, expected) => {
    expect(documentTitleFor(path, ITEMS)).toBe(expected);
  });

  test("never places a session title or query string in browser history", () => {
    expect(documentTitleFor("/sessions/42?title=private-repository", ITEMS)).toBe(
      "Session detail · Decant",
    );
  });
});
