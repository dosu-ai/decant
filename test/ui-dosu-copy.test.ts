import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const main = readFileSync(join(root, "src", "ui", "main.tsx"), "utf8");
const badge = readFileSync(join(root, "src", "ui", "dosu-badge.ts"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const npmReadme = readFileSync(join(root, "npm", "decant", "README.md"), "utf8");

describe("Dosu product copy", () => {
  test("keeps attribution, contextual conversion, privacy, and provenance distinct", () => {
    expect(main).toContain("<span>Created by Dosu</span>");
    expect(main).not.toContain("Built by Dosu ↗");
    expect(main).toContain("Make these patterns available to every coding agent");
    expect(main).toContain("Your agents keep relearning what your team already knows.");
    expect(main).toContain("Dosu gets them that knowledge faster and cheaper.");
    expect(main).toContain("Decant is an open source");
    expect(main).toContain(
      "Decant makes no outbound network calls. Your session logs stay on this machine.",
    );
    expect(main).toContain("Version {versionLabel(config?.version)}");
    expect(main).not.toContain('label="Dosu suggestions"');
    expect(main).toContain("localStorage.getItem(DOSU_ANALYTICS_DISMISSAL_KEY)");
    expect(main).toContain('localStorage.setItem(DOSU_ANALYTICS_DISMISSAL_KEY, "1")');
    expect(badge).toContain('"Optimized"');
    expect(main).toContain('["summary", "dateBounds", "config"]');
    expect(main).toContain("Decant {versionLabel(data.config?.version)}");
    expect(main).not.toContain("Decant {versionLabel(data.config?.version)} ↗");
    expect(main).toContain('context.fillText("Decant", 114, 83)');
    expect(main).toContain('context.fillText("Decant · by Dosu", SHARE_CARD_WIDTH - 210, 557)');
    expect(main).not.toContain("saved you $");
  });

  test("uses current Dosu positioning and tracked links in public documentation", () => {
    expect(readme).toContain(
      "https://dosu.dev?utm_source=decant&utm_medium=github&utm_campaign=attribution&utm_content=readme",
    );
    expect(npmReadme).toContain(
      "https://dosu.dev?utm_source=decant&utm_medium=npm&utm_campaign=attribution&utm_content=package_readme",
    );
    for (const document of [readme, npmReadme]) {
      const normalized = document.replaceAll("\n", " ");
      expect(normalized).toContain("Knowledge Infrastructure for Agents");
      expect(normalized).toContain(
        "Dosu makes agents faster, cheaper, and more effective across every run.",
      );
      expect(normalized).toContain(
        "Decant is local-first. It makes no outbound network calls at runtime,",
      );
    }
  });
});
