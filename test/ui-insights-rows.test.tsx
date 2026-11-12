import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { formatInt } from "../src/ui/format.ts";
import type { Recommendation, SettingsInfo } from "../src/ui/types.ts";
import {
  handoffPrompt,
  InsightsView,
  isLongPrompt,
  memoryLayerCopy,
  PromotionPanel,
  PromptPreview,
  RecommendationActions,
  type RecommendationHandlers,
  RecommendationHero,
  RecommendationRow,
  recommendationAction,
  recommendationFacts,
} from "../src/ui/views/insights.tsx";

const styles = readFileSync(join(import.meta.dir, "..", "src", "ui", "styles.css"), "utf8").replace(
  /\r\n/g,
  "\n",
);

function rule(selector: string): string {
  const start = styles.indexOf(`\n${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = styles.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return styles.slice(start, end);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const DETAIL = "16 distinct sessions read it in the last 30 days, with almost no edits.";
const SUGGESTION = "Distill what agents need from the file into AGENTS.md.";

function signal(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    key: "signal:hot-context:src/isolation.ts",
    kind: "signal",
    status: "open",
    category: null,
    title: "Agents re-read src/isolation.ts in 16 sessions this month",
    detail: DETAIL,
    suggestion: SUGGESTION,
    prompt: "Read src/isolation.ts and distill what agents need into AGENTS.md.",
    url: "https://example.test/skills",
    link_label: "Skills guide",
    icon: "hero-book-open",
    impact_label: "16 sessions",
    tone: "accent",
    score: 16,
    action: SUGGESTION,
    memory_layer: "Hot",
    promotion_target: "AGENTS.md or Skill",
    trigger: "At session start.",
    evidence: DETAIL,
    success_metric: "Repeat reads of the source file drop.",
    note: null,
    implemented_at: null,
    ...overrides,
  };
}

function catalogRow(overrides: Partial<Recommendation> = {}): Recommendation {
  return signal({
    key: "catalog:skills",
    kind: "catalog",
    category: "Reusable workflows",
    title: "Skills",
    detail: "Capture a repeated procedure once as a SKILL.md.",
    suggestion: null,
    prompt: "Scaffold a reusable Skill for a workflow I repeat often.",
    impact_label: null,
    tone: null,
    score: 0,
    action: "Scaffold a reusable Skill for a workflow I repeat often.",
    evidence: "Capture a repeated procedure once as a SKILL.md.",
    memory_layer: "Procedural",
    promotion_target: "SKILL.md",
    ...overrides,
  });
}

const handlers: RecommendationHandlers = {
  agentLabel: "Claude",
  canLaunch: true,
  copiedKey: null,
  onComplete: () => {},
  onCopy: () => {},
  pending: {},
};

const settingsInfo: SettingsInfo = {
  settings: { agent: "claude", terminal: "terminal", ide: "vscode", updateCheck: false },
  path: "/synthetic/settings.json",
  can_launch: true,
  options: { agents: [["claude", "Claude"]], terminals: [], ides: [] },
};

describe("Insights rows", () => {
  test("a row is one disclosure button that carries the whole title", () => {
    const row = signal({
      title:
        '"mcp__warehouse-inventory-reconciliation__reconcile_purchase_order_line_items" fails 40% of the time',
    });
    const html = renderToStaticMarkup(<RecommendationRow row={row} {...handlers} />);
    expect(count(html, "<button")).toBe(1);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(
      "mcp__warehouse-inventory-reconciliation__reconcile_purchase_order_line_items",
    );
    expect(html).toContain('<strong class="signal-row-impact">16 sessions</strong>');
  });

  test("titles wrap instead of truncating", () => {
    const title = rule(".signal-row-title");
    expect(title).toContain("overflow-wrap: anywhere");
    expect(title).not.toContain("nowrap");
    expect(title).not.toContain("text-overflow");
    const summary = rule(".signal-row-summary");
    expect(summary).toContain("grid-template-columns: 32px minmax(0, 1fr) auto auto");
    expect(rule(".signal-hero h3")).toContain("overflow-wrap: anywhere");
  });

  test("a row without an impact label shows no badge and never the tone name", () => {
    const html = renderToStaticMarkup(<RecommendationRow row={catalogRow()} {...handlers} />);
    expect(html).not.toContain("signal-row-impact");
    expect(html).not.toContain(">neutral<");
    const hero = renderToStaticMarkup(
      <RecommendationHero row={signal({ impact_label: null })} {...handlers} />,
    );
    expect(hero).not.toContain("<strong>");
  });
});

describe("Insights facts", () => {
  test("drops the evidence that repeats the detail", () => {
    expect(recommendationFacts(signal())).toEqual({
      summary: DETAIL,
      suggestion: SUGGESTION,
      evidence: null,
    });
    const html = renderToStaticMarkup(<RecommendationHero row={signal()} {...handlers} />);
    // The prompt is shown verbatim, and it quotes the detail as its evidence.
    const outsidePrompt = html.replace(/<pre[^>]*>[\s\S]*?<\/pre>/g, "");
    expect(count(html, "<pre")).toBe(1);
    expect(count(outsidePrompt, DETAIL)).toBe(1);
    expect(count(outsidePrompt, SUGGESTION)).toBe(1);
    expect(outsidePrompt).not.toContain(">Evidence<");
  });

  test("keeps evidence that says something new", () => {
    const facts = recommendationFacts(signal({ evidence: "Sessions 12, 14 and 19 read it." }));
    expect(facts.evidence).toBe("Sessions 12, 14 and 19 read it.");
  });

  test("a detail that only restates the impact label gives way to the suggestion", () => {
    const facts = recommendationFacts(
      signal({ detail: "12518 calls.", evidence: "12518 calls.", impact_label: "12518 calls" }),
    );
    expect(facts).toEqual({ summary: SUGGESTION, suggestion: null, evidence: null });
  });

  test("a row with nothing but a title has no summary line", () => {
    const facts = recommendationFacts(signal({ detail: null, suggestion: null, evidence: null }));
    expect(facts).toEqual({ summary: null, suggestion: null, evidence: null });
  });
});

describe("Insights plan panel", () => {
  test("uses plain labels and says what the panel is for", () => {
    const html = renderToStaticMarkup(<PromotionPanel row={signal()} />);
    expect(html).toContain("Where to record this so future agent sessions use it");
    expect(html).toContain("<dt>Record it in</dt><dd>AGENTS.md or Skill</dd>");
    expect(html).toContain("<dt>How agents get it</dt><dd>Loaded in every session</dd>");
    expect(html).toContain("<dt>When it applies</dt>");
    expect(html).toContain("<dt>It worked when</dt>");
    for (const jargon of ["Memory card", "Layer", "Promote to", "Trigger", "Done when", "Hot"]) {
      expect(html).not.toContain(jargon);
    }
  });

  test("shows a memory layer it does not know as the API sent it", () => {
    expect(memoryLayerCopy("Procedural")).toBe("Loaded when a task calls for it");
    expect(memoryLayerCopy("Archive")).toBe("Archive");
  });

  test("keeps small labels on the muted token, which passes AA on the row surfaces", () => {
    const labels = styles.slice(
      styles.indexOf(".signal-kicker,\n.signal-label,"),
      styles.indexOf(".signal-hero h3 {"),
    );
    expect(labels).toContain("color: var(--muted)");
    expect(styles).toContain(".promotion-panel dt {\n  color: var(--muted);");
    expect(styles).toContain(".promotion-panel dd {\n  color: var(--fg);");
    expect(styles).not.toContain(".suggestion-block");
  });
});

describe("Insights prompt preview", () => {
  test("shows the exact prompt before the user launches it", () => {
    const row = signal();
    const html = renderToStaticMarkup(<PromptPreview agentLabel="Claude" canLaunch row={row} />);
    expect(html).toContain("Run opens Claude in a terminal and sends it this prompt.");
    expect(html).toContain(`<pre class="signal-prompt-text">${handoffPrompt(row)}</pre>`);
    expect(html).toContain("decant recommendations mark signal:hot-context:src/isolation.ts");
  });

  test("collapses a long prompt and opens a short one", () => {
    const long = signal();
    expect(isLongPrompt(handoffPrompt(long))).toBe(true);
    expect(
      renderToStaticMarkup(<PromptPreview agentLabel="Claude" canLaunch row={long} />),
    ).toContain('<details class="signal-prompt">');

    const short = signal({
      prompt: "Add a code map.",
      memory_layer: null,
      promotion_target: null,
      trigger: null,
      evidence: null,
      action: null,
      success_metric: null,
    });
    const prompt = handoffPrompt(short);
    expect(isLongPrompt(prompt)).toBe(false);
    expect(
      renderToStaticMarkup(<PromptPreview agentLabel="Claude" canLaunch row={short} />),
    ).toContain('<details class="signal-prompt" open="">');
    expect(isLongPrompt("x".repeat(400))).toBe(true);
  });

  test("explains the copy action when no launcher is available", () => {
    const html = renderToStaticMarkup(
      <PromptPreview agentLabel={null} canLaunch={false} row={signal()} />,
    );
    expect(html).toContain("Copy setup prompt puts this text on your clipboard.");
    expect(html).not.toContain("decant recommendations mark");
  });

  test("renders nothing for a row without a prompt", () => {
    expect(
      renderToStaticMarkup(
        <PromptPreview agentLabel="Claude" canLaunch row={signal({ prompt: null })} />,
      ),
    ).toBe("");
  });
});

describe("Insights row actions", () => {
  const actions = (row: Recommendation, overrides: Partial<RecommendationHandlers> = {}) =>
    renderToStaticMarkup(<RecommendationActions row={row} {...handlers} {...overrides} />);

  test("names each button after what it does", () => {
    expect(recommendationAction(signal(), true)).toBe("launch");
    expect(recommendationAction(signal(), false)).toBe("copy");
    expect(recommendationAction(signal({ prompt: null }), true)).toBe("mark");
    expect(
      recommendationAction(signal({ prompt: null, action: null, suggestion: null }), true),
    ).toBe(null);

    const launch = actions(signal());
    expect(launch).toContain("Run in Claude");
    expect(launch).toContain("Copy setup prompt");

    const copyOnly = actions(signal(), { canLaunch: false, agentLabel: null });
    expect(copyOnly).not.toContain("Run");
    expect(copyOnly).toContain("Copy setup prompt");

    const mark = actions(signal({ prompt: null }));
    expect(mark).toContain("Mark as done");
    expect(mark).not.toContain("Run");
    expect(mark).not.toContain("Copy setup prompt");
  });

  test("reports progress and a finished copy on the button that was pressed", () => {
    const key = signal().key;
    expect(actions(signal(), { pending: { [key]: "launch" } })).toContain("Opening");
    expect(actions(signal(), { pending: { [key]: "copy" } })).toContain("Copying");
    expect(actions(signal(), { copiedKey: key })).toContain("Copied");
    expect(actions(signal(), { pending: { [key]: "copy" } })).toContain('disabled=""');
    expect(actions(signal(), { pending: { other: "copy" } })).not.toContain('disabled=""');
    // A second row's action leaves this row's launch in flight.
    const both = actions(signal(), { pending: { [key]: "launch", other: "copy" } });
    expect(both).toContain("Opening");
    expect(both).toContain('disabled=""');
  });

  test("keeps the prompt copyable while a launch is still running", () => {
    // A launch request that never answers must not lock the only other way to
    // hand the prompt to an agent.
    const key = signal().key;
    const launching = actions(signal(), { pending: { [key]: "launch" } });
    const buttons = launching.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toContain('disabled=""');
    expect(buttons[1]).not.toContain('disabled=""');
    expect(launching).toContain("Copy setup prompt");
  });

  test("gives row actions a 44px target on touch layouts", () => {
    const start = styles.indexOf("@media (pointer: coarse), (max-width: 767px)");
    expect(start).toBeGreaterThanOrEqual(0);
    const touch = styles.slice(start, styles.indexOf("\n}\n", start));
    expect(touch).toContain(".recommendation-actions :is(.primary-button, .secondary-button)");
    expect(touch).toContain(".signal-prompt-toggle");
    expect(touch).toContain(".dosu-row-action");
    expect(touch).toContain("min-height: 44px");
    expect(touch).toContain("width: 44px");
    expect(rule(".signal-row-summary")).toContain("min-height: 58px");
  });
});

describe("Insights page sections", () => {
  const render = (rows: Recommendation[]) =>
    renderToStaticMarkup(
      <InsightsView
        loading={false}
        loadFailed={false}
        onMarked={() => {}}
        rows={rows}
        settingsInfo={settingsInfo}
      />,
    );

  test("sets the static catalog apart from measured signals", () => {
    const html = render([signal(), catalogRow()]);
    const catalogStart = html.indexOf("insights-catalog");
    expect(catalogStart).toBeGreaterThan(html.indexOf("Patterns worth acting on"));
    const catalog = html.slice(catalogStart);
    expect(catalog).toContain("<h2>Setup ideas</h2>");
    expect(catalog).toContain("General suggestions that apply to any project.");
    expect(catalog).toContain("Decant did not derive them from your archive.");
    expect(catalog).toContain("Skills");
    expect(catalog).not.toContain("Agents re-read");
    expect(rule(".insights-catalog")).toContain("border-top: 1px solid var(--line)");
  });

  test("formats the counts it prints with the shared integer formatter", () => {
    const rows = Array.from({ length: 1200 }, (_, index) =>
      signal({ key: `signal:synthetic:${index}`, score: index }),
    );
    const html = render([...rows, catalogRow()]);
    // The separator follows the process locale, so ask the formatter for it.
    expect(html).toContain(`${formatInt(1200)} active`);
    expect(html).toContain("1 idea<");
  });
});
