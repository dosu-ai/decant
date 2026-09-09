import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");

describe("Gemini CLI source copy", () => {
  test("labels Gemini sessions instead of falling back to the wire string", () => {
    expect(main).toMatch(/tool === "gemini"[\s\S]{0,300}tone="gemini"[\s\S]{0,200}Gemini/);
    expect(main).toContain('{ key: "gemini", label: "Gemini"');
  });

  test("gives Gemini models a brand tone and icon", () => {
    expect(main).toMatch(/normalized\.includes\("gemini"\)[\s\S]{0,120}"gemini"/);
    expect(main).toMatch(/tone === "gemini"[\s\S]{0,60}return "gemini"/);
  });

  test("shows the derived thinking state when effort is unrecorded but reasoning is observed", () => {
    // Gemini CLI logs extended-thinking tokens but no discrete effort level,
    // so the Effort cell falls back to a derived badge instead of "-".
    expect(main).toContain("thinking on");
    expect(main).toContain("This source does not record a discrete effort level.");
    // The badge only appears for observed reasoning, never as a guessed "off".
    expect(main).toMatch(/\(effort \?\? ""\)\.trim\(\) === "" && totalReasoningTokens > 0/);
    expect(main).not.toContain("thinking off");
  });

  test("names Gemini CLI alongside Claude Code and Codex in product copy", () => {
    expect(main).toContain("Every Claude Code, Codex, and Gemini CLI session log on this device.");
    expect(main).toMatch(/JSONL logs Claude Code, Codex, and Gemini CLI already write/);
  });
});
