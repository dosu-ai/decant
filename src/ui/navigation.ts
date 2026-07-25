/**
 * Route resolution for the sidebar. Kept apart from the view layer so the
 * mapping can be tested directly: which destination a URL belongs to decides
 * what renders and which sidebar entry is marked current, and both are easy to
 * get subtly wrong when routes move.
 */

/** The part of a nav item this module reads; the UI's own type adds an icon. */
export interface NavDestination {
  key: string;
  href: string;
  label: string;
}

/** The landing route. Analytics answers the question the tool exists for. */
export const HOME_LABEL = "Analytics";
export const HOME_KEY = "analytics";

export function pathOnly(path: string): string {
  // `split` always yields at least one element, so the empty case needs an
  // explicit check rather than a `??` fallback that can never fire.
  const pathname = path.split("?", 1)[0];
  return pathname == null || pathname === "" ? "/" : pathname;
}

/**
 * A session transcript resolves to Sessions rather than to itself. The reader
 * arrived from that list and returns to it, so leaving the sidebar on Sessions
 * keeps the trail visible while reading.
 */
function resolve(path: string, items: readonly NavDestination[]): NavDestination | null {
  const pathname = pathOnly(path);
  if (pathname === "/sessions" || pathname.startsWith("/sessions/")) {
    return items.find((item) => item.key === "sessions") ?? null;
  }
  if (pathname === "/settings") {
    return { key: "settings", href: "/settings", label: "Settings" };
  }
  if (pathname === "/") {
    return items.find((item) => item.key === HOME_KEY) ?? null;
  }
  return items.find((item) => item.href === pathname) ?? null;
}

export function activeRoute(path: string, items: readonly NavDestination[]): string {
  return resolve(path, items)?.label ?? HOME_LABEL;
}

export function activeRouteKey(path: string, items: readonly NavDestination[]): string {
  return resolve(path, items)?.key ?? HOME_KEY;
}

export function titleFor(active: string): string {
  return active === "Sessions" ? "Session Archive" : active;
}
