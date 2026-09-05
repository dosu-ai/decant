import { describe, expect, test } from "bun:test";
import { dashboardSourceOptions, sourceScopeQuery } from "../src/ui/source-scope.ts";

describe("dashboard source scope", () => {
  test("combines source and date filters in one request scope", () => {
    expect(sourceScopeQuery("from=2026-08-20&to=2026-08-26", "codex_app")).toBe(
      "from=2026-08-20&to=2026-08-26&source=codex_app",
    );
  });

  test("offers only sources present in the archive", () => {
    expect(
      dashboardSourceOptions([
        { key: "claude_code", label: "Claude Code" },
        { key: "codex_cli", label: "Codex CLI" },
      ]),
    ).toEqual([
      { key: "", label: "All sources" },
      { key: "claude_code", label: "Claude Code" },
      { key: "codex_cli", label: "Codex CLI" },
    ]);
  });
});
