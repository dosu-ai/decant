import { describe, expect, test } from "bun:test";
import { type LinkClick, shouldInterceptLinkClick } from "../src/ui/link-click.ts";
import { readUiSource } from "./ui-source.ts";

const plain: LinkClick = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};

describe("shouldInterceptLinkClick", () => {
  test("routes a plain primary click on an internal path", () => {
    expect(shouldInterceptLinkClick(plain, { href: "/sessions/12" })).toBe(true);
    expect(shouldInterceptLinkClick(plain, { href: "/sessions?project=a", target: "_self" })).toBe(
      true,
    );
    expect(shouldInterceptLinkClick(plain, { href: "/sessions/1#message-3", target: "" })).toBe(
      true,
    );
  });

  test("leaves modified and non-primary clicks to the browser", () => {
    for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(shouldInterceptLinkClick({ ...plain, [key]: true }, { href: "/sessions" })).toBe(
        false,
      );
    }
    expect(shouldInterceptLinkClick({ ...plain, button: 1 }, { href: "/sessions" })).toBe(false);
    expect(shouldInterceptLinkClick({ ...plain, button: 2 }, { href: "/sessions" })).toBe(false);
  });

  test("leaves new-tab, download and already-handled links alone", () => {
    expect(shouldInterceptLinkClick(plain, { href: "/sessions", target: "_blank" })).toBe(false);
    expect(shouldInterceptLinkClick(plain, { href: "/api/export", download: true })).toBe(false);
    expect(shouldInterceptLinkClick({ ...plain, defaultPrevented: true }, { href: "/x" })).toBe(
      false,
    );
  });

  test("never intercepts external or protocol-relative URLs", () => {
    expect(shouldInterceptLinkClick(plain, { href: "https://github.com/dosu-ai/decant" })).toBe(
      false,
    );
    expect(shouldInterceptLinkClick(plain, { href: "//example.com/path" })).toBe(false);
    expect(shouldInterceptLinkClick(plain, { href: "#message-4" })).toBe(false);
  });
});

describe("internal links in the UI source", () => {
  const source = readUiSource();

  test("route through Link instead of a bare anchor or a hand-rolled navigate", () => {
    expect(source).toContain("function Link(");
    expect(source).not.toContain("navigate(event");
    const bareInternal = source.match(
      /<a\s[^>]*?href=\{?(?:`\/|"\/|projectSessionsHref|sessionsArchivedHref)/g,
    );
    expect(bareInternal).toBeNull();
  });
});
