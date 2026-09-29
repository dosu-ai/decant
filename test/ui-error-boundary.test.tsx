import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundary } from "../src/ui/error-boundary.tsx";

describe("root error boundary", () => {
  test("renders its children while nothing has failed", () => {
    const html = renderToStaticMarkup(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    );
    expect(html).toBe("<p>all good</p>");
  });

  test("turns a render error into a recoverable alert with a reload button", () => {
    expect(ErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });

    const boundary = new ErrorBoundary({ children: <p>child-content</p> });
    boundary.state = ErrorBoundary.getDerivedStateFromError();
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Reload Decant");
    expect(html).toContain('class="primary-button"');
    expect(html).not.toContain("child-content");
  });

  test("wraps the whole app at the render root", () => {
    const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");
    expect(main).toContain("<ErrorBoundary>");
    expect(main).toMatch(/<ErrorBoundary>\s*<App \/>\s*<\/ErrorBoundary>/);
  });
});
