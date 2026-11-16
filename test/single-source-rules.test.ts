import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type DateFilter, sessionDatePredicate } from "../src/date-filter.ts";
import { AGENT_CONTEXT_SQL } from "../src/query.ts";
import {
  economicsVectorMatchesFilter,
  type SessionEconomicsVector,
} from "../src/token-economics.ts";

function sqlMatches(db: Database, sql: string, params: string[], value: string | null): boolean {
  const row = db
    .query(`SELECT (${sql}) AS hit FROM (SELECT ? AS text, ? AS started_at) b`)
    .get(...params, value, value) as { hit: number | null };
  return row.hit === 1;
}

describe("economicsVectorMatchesFilter agrees with sessionDatePredicate", () => {
  const startedAt = [
    null,
    "2026-03-09",
    "2026-03-10",
    "2026-03-10T00:00:00.000Z",
    "2026-03-10T23:59:59.999+05:30",
    "2026-03-10 08:00",
    "2026-03-11T00:00:00Z",
    "2026-03-1",
    "2026-03",
    "",
  ];
  const filters: DateFilter[] = [
    {},
    { from: "2026-03-10" },
    { to: "2026-03-10" },
    { from: "2026-03-10", to: "2026-03-10" },
    { from: "2026-03-09", to: "2026-03-11" },
    { from: "2026-03-11", to: "2026-03-09" },
  ];

  for (const filter of filters) {
    test(`from ${filter.from ?? "-"} to ${filter.to ?? "-"}`, () => {
      const db = new Database(":memory:");
      const predicate = sessionDatePredicate("b", filter);
      for (const value of startedAt) {
        const sql = predicate.sql === "" ? "1" : predicate.sql;
        const vector = { started_at: value } as SessionEconomicsVector;
        expect({ value, hit: economicsVectorMatchesFilter(vector, filter) }).toEqual({
          value,
          hit: sqlMatches(db, sql, predicate.params, value),
        });
      }
    });
  }
});

describe("AGENT_CONTEXT_SQL", () => {
  const samples = [
    "<permissions instructions>run nothing",
    "<PERMISSIONS INSTRUCTIONS>run nothing",
    "   <local-command-caveat>x",
    "\t<local-command-caveat>x",
    "<local-command-stdout>ok",
    "<local-command-stderr>no",
    "<local-command-output>ok",
    "<command-name>/clear</command-name>",
    "prefix <environment_context>cwd</environment_context>",
    "prefix <ENVIRONMENT_CONTEXT>",
    "# AGENTS.md instructions for /repo",
    "# agents.md instructions for /repo",
    "see <INSTRUCTIONS>do it</INSTRUCTIONS>",
    "see <instructions>",
    "The following is the Codex agent history",
    "use prior reviews as context when reviewing",
    "<system_reminder>be brief",
    "<system-reminder>be brief",
    "<systemXreminder>be brief",
    '<teammate-message summary="fix it">',
    "<fork-boilerplate>Your directive: fix it",
    "You are root, the primary agent here",
    "<collaboration_mode>pair",
    "Fix the failing test in src/query.ts",
    "100% sure the _ wildcard is literal",
  ];

  test("SQL skips each listed marker and leaves subagent task wrappers to TypeScript", () => {
    const db = new Database(":memory:");
    const skipped = samples.filter((text) => sqlMatches(db, AGENT_CONTEXT_SQL, [], text));
    expect(skipped).toEqual([
      "<permissions instructions>run nothing",
      "<PERMISSIONS INSTRUCTIONS>run nothing",
      "   <local-command-caveat>x",
      "<local-command-stdout>ok",
      "<local-command-stderr>no",
      "<local-command-output>ok",
      "<command-name>/clear</command-name>",
      "prefix <environment_context>cwd</environment_context>",
      "# AGENTS.md instructions for /repo",
      "see <INSTRUCTIONS>do it</INSTRUCTIONS>",
      "The following is the Codex agent history",
      "use prior reviews as context when reviewing",
      "<system_reminder>be brief",
    ]);
  });
});
