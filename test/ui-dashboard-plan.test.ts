import { describe, expect, test } from "bun:test";
import {
  type DashboardEndpoint,
  dashboardEndpointStamp,
  dashboardRouteForPath,
  planDashboardFetches,
  routeLoadsSessionList,
} from "../src/ui/dashboard-plan.ts";

function stampsFor(
  endpoints: DashboardEndpoint[],
  context: { dateQuery: string; reloadKey: number },
): Partial<Record<DashboardEndpoint, string>> {
  const loaded: Partial<Record<DashboardEndpoint, string>> = {};
  for (const endpoint of endpoints) {
    loaded[endpoint] = dashboardEndpointStamp(endpoint, context);
  }
  return loaded;
}

describe("dashboardRouteForPath", () => {
  test("classifies every UI route", () => {
    expect(dashboardRouteForPath("/")).toBe("sessions");
    expect(dashboardRouteForPath("/sessions")).toBe("sessions");
    expect(dashboardRouteForPath("/sessions/42")).toBe("session-detail");
    expect(dashboardRouteForPath("/projects")).toBe("projects");
    expect(dashboardRouteForPath("/search")).toBe("search");
    expect(dashboardRouteForPath("/analytics")).toBe("analytics");
    expect(dashboardRouteForPath("/insights")).toBe("insights");
    expect(dashboardRouteForPath("/tools")).toBe("tools");
    expect(dashboardRouteForPath("/files")).toBe("files");
    expect(dashboardRouteForPath("/settings")).toBe("settings");
    expect(dashboardRouteForPath("/nonsense")).toBe("sessions");
  });

  test("only the sessions list route loads the sessions collection", () => {
    expect(routeLoadsSessionList("sessions")).toBe(true);
    expect(routeLoadsSessionList("session-detail")).toBe(false);
    expect(routeLoadsSessionList("analytics")).toBe(false);
  });
});

describe("planDashboardFetches", () => {
  test("a session-detail deep link fetches only the shared chrome data", () => {
    const plan = planDashboardFetches({
      dateQuery: "",
      loaded: {},
      reloadKey: 0,
      route: "session-detail",
    });
    expect(plan.toSorted()).toEqual(["now", "summary"]);
  });

  test("the sessions route adds only the date bounds on top of the chrome", () => {
    const plan = planDashboardFetches({
      dateQuery: "",
      loaded: {},
      reloadKey: 0,
      route: "sessions",
    });
    expect(plan.toSorted()).toEqual(["dateBounds", "now", "summary"]);
  });

  test("the analytics route plans its charts without insights or settings data", () => {
    const plan = planDashboardFetches({
      dateQuery: "",
      loaded: {},
      reloadKey: 0,
      route: "analytics",
    });
    expect(plan.toSorted()).toEqual([
      "activity",
      "byDay",
      "byModel",
      "byProject",
      "dateBounds",
      "modelSparklines",
      "now",
      "summary",
      "tokenEconomics",
    ]);
  });

  test("navigating to a warm route plans nothing", () => {
    const context = { dateQuery: "from=2026-06-01&to=2026-06-30", reloadKey: 3 };
    const loaded = stampsFor(["dateBounds", "now", "summary"], context);
    expect(planDashboardFetches({ ...context, loaded, route: "sessions" })).toEqual([]);
  });

  test("a date change refetches only date-sensitive endpoints", () => {
    const before = { dateQuery: "", reloadKey: 1 };
    const loaded = stampsFor(
      [
        "activity",
        "byDay",
        "byModel",
        "byProject",
        "dateBounds",
        "modelSparklines",
        "now",
        "summary",
        "tokenEconomics",
      ],
      before,
    );
    const plan = planDashboardFetches({
      dateQuery: "from=2026-06-01&to=2026-06-30",
      loaded,
      reloadKey: 1,
      route: "analytics",
    });
    expect(plan.toSorted()).toEqual([
      "activity",
      "byDay",
      "byModel",
      "byProject",
      "modelSparklines",
      "summary",
      "tokenEconomics",
    ]);
  });

  test("an archive update refetches archive-sensitive data but never config or settings", () => {
    const before = { dateQuery: "", reloadKey: 1 };
    const loaded = {
      ...stampsFor(["config", "now", "settings", "summary"], before),
    };
    const plan = planDashboardFetches({
      dateQuery: "",
      loaded,
      reloadKey: 2,
      route: "settings",
    });
    expect(plan.toSorted()).toEqual(["now", "summary"]);
  });

  test("insights refetches recommendations after a mark bumps the reload key", () => {
    const before = { dateQuery: "", reloadKey: 5 };
    const loaded = stampsFor(["now", "recommendations", "settings", "summary"], before);
    const plan = planDashboardFetches({ dateQuery: "", loaded, reloadKey: 6, route: "insights" });
    expect(plan.toSorted()).toEqual(["now", "recommendations", "summary"]);
  });

  test("projects and recommendations ignore date changes", () => {
    const before = { dateQuery: "", reloadKey: 0 };
    const projectsLoaded = stampsFor(["now", "projects", "summary"], before);
    const plan = planDashboardFetches({
      dateQuery: "from=2026-07-01",
      loaded: projectsLoaded,
      reloadKey: 0,
      route: "projects",
    });
    expect(plan.toSorted()).toEqual(["summary"]);
  });

  test("stamps pin the axes an endpoint is insensitive to", () => {
    expect(dashboardEndpointStamp("summary", { dateQuery: "from=x", reloadKey: 2 })).toBe(
      "from=x|2",
    );
    expect(dashboardEndpointStamp("projects", { dateQuery: "from=x", reloadKey: 2 })).toBe("*|2");
    expect(dashboardEndpointStamp("config", { dateQuery: "from=x", reloadKey: 2 })).toBe("*|*");
  });
});
