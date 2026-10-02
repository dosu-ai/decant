import type { AnchorHTMLAttributes } from "react";
import { shouldInterceptLinkClick } from "./link-click.ts";
import { pathOnly } from "./navigation.ts";
import { searchRouteHref } from "./search-request.ts";

export function locationPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function updateSearchRoute(query: string, setPath?: (path: string) => void) {
  const href = searchRouteHref(query, locationPath());
  if (pathOnly(locationPath()) === "/search") {
    window.history.replaceState(null, "", href);
  } else {
    window.history.pushState(null, "", href);
  }
  const next = locationPath();
  if (setPath != null) {
    setPath(next);
  } else {
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  setPath?: (path: string) => void;
};

export function Link({ href, setPath, onClick, ...rest }: LinkProps) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          shouldInterceptLinkClick(event, {
            href,
            target: rest.target,
            download: rest.download != null && rest.download !== false,
          })
        ) {
          event.preventDefault();
          visit(href, setPath);
        }
      }}
    />
  );
}

export function visit(href: string, setPath?: (path: string) => void) {
  const previousPathname = window.location.pathname;
  window.history.pushState(null, "", href);
  // pushState keeps the old scroll offset, which a full page load used to reset.
  if (window.location.pathname !== previousPathname) {
    window.scrollTo(0, 0);
  }
  const next = locationPath();
  if (setPath != null) {
    setPath(next);
  } else {
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
