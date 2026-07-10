import { describe, expect, test } from "bun:test";
import { activeRoute, activeRouteKey, navItems, titleFor } from "../src/ui/routes.ts";

describe("ui routes", () => {
  test("root path lands on Analytics", () => {
    expect(activeRoute("/")).toBe("Analytics");
    expect(activeRouteKey("/")).toBe("analytics");
  });

  test("analytics is the first nav item", () => {
    expect(navItems[0]?.key).toBe("analytics");
  });

  test("unknown paths fall back to Analytics", () => {
    expect(activeRoute("/definitely-not-a-page")).toBe("Analytics");
    expect(activeRouteKey("/definitely-not-a-page")).toBe("analytics");
  });

  test("session detail routes stay in Sessions", () => {
    expect(activeRoute("/sessions/42")).toBe("Sessions");
    expect(activeRouteKey("/sessions/42?from=list")).toBe("sessions");
  });

  test("search and settings stay routable without sidebar slots", () => {
    expect(activeRoute("/search")).toBe("Search");
    expect(activeRoute("/settings")).toBe("Settings");
  });

  test("topbar title matches the nav label exactly", () => {
    expect(titleFor("Sessions")).toBe("Sessions");
  });
});
