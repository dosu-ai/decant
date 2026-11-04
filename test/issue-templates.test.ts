import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS, type Tool } from "../src/model.ts";

// A new source must show up in the bug form, or reports about it arrive
// without saying which tool wrote the sessions. Record<Tool, ...> makes the
// type check fail until a label is added here.
const BUG_FORM_LABELS: Record<Tool, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  cursor: "Cursor CLI",
  copilot: "GitHub Copilot CLI",
};

interface FormField {
  id?: string;
  type: string;
  attributes: { options?: string[]; value?: string };
}

function bugForm(): FormField[] {
  const path = join(import.meta.dir, "..", ".github", "ISSUE_TEMPLATE", "bug_report.yml");
  return (Bun.YAML.parse(readFileSync(path, "utf8")) as { body: FormField[] }).body;
}

describe("bug report form", () => {
  test("offers every source tool", () => {
    const field = bugForm().find((item) => item.id === "source-tool");
    expect(field?.attributes.options).toEqual([
      ...TOOLS.map((tool) => BUG_FORM_LABELS[tool]),
      "Not applicable",
    ]);
  });

  test("names every source tool in the privacy warning", () => {
    const intro = bugForm().find((item) => item.type === "markdown")?.attributes.value ?? "";
    const prose = intro.replace(/\s+/g, " ");
    for (const tool of TOOLS) {
      expect(prose).toContain(BUG_FORM_LABELS[tool]);
    }
  });
});
