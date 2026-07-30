import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");
const styles = readFileSync(join(import.meta.dir, "..", "src", "ui", "styles.css"), "utf8");
const insightsView = main.slice(
  main.indexOf("function InsightsView("),
  main.indexOf("function DosuInsightsRow()"),
);

describe("Insights information hierarchy", () => {
  test("explains how archive evidence becomes future-agent improvements", () => {
    expect(main).toContain("Session logs → action");
    expect(main).toContain("Decant finds recurring patterns in your local sessions");
    expect(main).toContain("Detected in your session logs");
    expect(main).toContain("Patterns worth acting on");
    expect(main).toContain("Reusable improvements");
    expect(main).toContain("Set up for future runs");
  });

  test("keeps the Dosu suggestion explicitly optional", () => {
    expect(main).toContain("Optional · Dosu");
    expect(main).toContain("function DosuInsightsRow()");
    expect(main).toContain('className="signal-row dosu-insights-row"');
    expect(main).toContain('dosuLink("insights_card")');
    expect(main).not.toContain("function DosuInsightsCard()");
    expect(styles).not.toContain(".dosu-insights-card");
  });

  test("always renders the Dosu suggestion without a settings gate", () => {
    expect(insightsView).not.toContain("showDosuSuggestion");
    expect(insightsView).not.toContain("dosuSuggestions");
    expect(insightsView).toMatch(
      /<div className="signal-list insights-dosu-list">\s*<DosuInsightsRow \/>\s*<\/div>/,
    );
  });

  test("uses expandable comparison rows instead of featured catalog cards", () => {
    expect(main).toContain("signal-row-summary");
    expect(main).toContain("signal-row-impact");
    expect(main).not.toContain("function RecommendationCard(");
    expect(main).not.toContain("is-featured");
  });

  test("moves secondary links into an accessible compact overflow menu", () => {
    expect(main).toContain("function RecommendationOverflow(");
    expect(main).toContain('className="recommendation-overflow"');
    expect(main).toMatch(/More actions for \$\{title\}/);
    expect(main).toContain('event.key !== "Escape"');
    expect(styles).toContain(".recommendation-overflow-menu");
    expect(styles).toContain(".recommendation-overflow > summary:focus-visible");
  });

  test("falls back when the clipboard API is unavailable and announces the result", () => {
    expect(main).toContain("async function copyTextToClipboard(");
    expect(main).toContain('document.execCommand("copy")');
    expect(main).toContain("Copied the setup prompt for");
    expect(main).toContain("Could not copy the setup prompt.");
    expect(main).toContain('role={copyFeedback.kind === "error" ? "alert" : "status"}');
    expect(main).not.toContain("void navigator.clipboard?.writeText(handoffPrompt(row))");
  });

  test("shows a skeleton instead of an empty state while recommendations load", () => {
    expect(main).toContain("const [recommendationsLoading, setRecommendationsLoading]");
    expect(main).toContain("function InsightsSignalsSkeleton()");
    expect(main).toContain("loading={actions.recommendationsLoading}");
    expect(main).toContain("loadFailed={actions.failedSlices.includes");
    expect(insightsView).toContain("loading: boolean");
    expect(insightsView).toContain("loadFailed: boolean");
    expect(insightsView).toMatch(
      /loading && signals\.length === 0 \? <InsightsSignalsSkeleton \/>/,
    );
    expect(insightsView).toMatch(
      /!loading && !loadFailed && signals\.length === 0 \? \(\s*<EmptyState/,
    );
    expect(styles).toContain(".insights-signals-skeleton");
  });

  test("keeps recommendations archive-wide so date changes cannot latch the skeleton", () => {
    const loaderStart = main.indexOf("  recommendations: {", main.indexOf("const SLICE_LOADERS"));
    const loader = main.slice(loaderStart, main.indexOf("  config: {", loaderStart));
    expect(loader).toContain("dateScoped: false");
    expect(loader).toContain("Recommendations are archive-wide.");
    expect(loader).toContain('getJson<Recommendation[]>("/api/recommendations?status=all")');
  });
});
