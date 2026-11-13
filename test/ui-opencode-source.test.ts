import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { brandTone, modelBrandIcon, providerIdentity, ToolBadge } from "../src/ui/badges.tsx";
import { readUiFile, readUiSource } from "./ui-source.ts";

const main = readUiSource();

describe("OpenCode source copy", () => {
  test("labels OpenCode sessions instead of falling back to the wire string", () => {
    const badge = renderToStaticMarkup(createElement(ToolBadge, { tool: "opencode" }));
    expect(badge).toContain('class="badge tone-opencode"');
    expect(badge).toEndWith("OpenCode</span>");
    expect(providerIdentity("opencode")).toEqual({
      key: "opencode",
      label: "OpenCode",
      tone: "opencode",
      icon: "opencode",
    });
  });

  test("gives GLM and Muse models their publisher's tone and icon", () => {
    expect(brandTone("glm-5.3-flash")).toBe("zai");
    expect(brandTone("zai/glm-5.3")).toBe("zai");
    expect(brandTone("meta/muse-wonder")).toBe("meta");
    expect(brandTone("muse-spark-1.3-contributor")).toBe("meta");
    expect(brandTone("claude-haiku-5-5")).toBe("claude");
    expect(brandTone("example-model")).toBe("neutral");
    expect(modelBrandIcon("glm-5.3", "zai")).toBe("zai");
    expect(modelBrandIcon("muse-wonder", "meta")).toBe("meta");
  });

  test("defines every new tone in the stylesheet", () => {
    const css = readUiFile("styles.css");
    for (const tone of ["opencode", "zai", "meta"]) {
      expect(css).toContain(`--${tone}:`);
      expect(css).toContain(`--${tone}-text:`);
      expect(css).toContain(`.tone-${tone} {`);
      expect(css).toContain(`.badge.tone-${tone} {`);
      expect(css).toContain(`.bar span.tone-${tone} {`);
      expect(css).toContain(`.sparkline.tone-${tone} {`);
    }
    expect(css).toContain(".provider-opencode {");
  });

  test("shows the provider next to the model and labels reported cost", () => {
    const detail = readUiFile("views/session-detail.tsx");
    expect(detail).toMatch(
      /<ModelBadge model=\{detail\.summary\.model\} \/>[\s\S]{0,200}detail\.summary\.model_provider/,
    );
    expect(detail).toContain("costSourceTooltip(detail.summary.cost_source)");
    expect(detail).toContain("costSourceLabel(detail.summary.cost_source)");
  });

  test("names OpenCode alongside the other sources in product copy", () => {
    // JSX text wraps wherever the formatter puts it, so compare it as rendered.
    const copy = main.replace(/\s+/g, " ");
    expect(copy).toContain(
      "Every Claude Code, Codex, Gemini CLI, OpenCode, Cursor CLI, GitHub Copilot CLI, and Copilot Chat in VS Code session log on this device, plus imported ATIF trajectories.",
    );
    expect(copy).toContain(
      "session logs Claude Code, Codex, Gemini CLI, OpenCode, Cursor CLI, GitHub Copilot CLI, and Copilot Chat in VS Code already write",
    );
    expect(copy).toContain(
      "local-first, searchable archive of Claude Code, Codex, Gemini CLI, OpenCode, Cursor CLI, GitHub Copilot CLI, and Copilot Chat in VS Code sessions, with ATIF import and export.",
    );
  });
});
