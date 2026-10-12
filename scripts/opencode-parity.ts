// Developer-only parity check between an OpenCode 2.x database, a Decant
// archive synced from it, and optionally the JSON the user produced by running
// `opencode stats --all --json` against their own OpenCode. Prints aggregate
// counts and totals only, never transcript text.
//
// SAFETY: this script never starts the OpenCode CLI or service. Running
// OpenCode against a copied database resumes in-progress sessions with the
// stored credentials and makes real, billed model calls. Both databases are
// opened read-only.
//
// Usage: bun run scripts/opencode-parity.ts <opencode.db> <decant.db> [stats.json]
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { defaultPricing, estimateCost } from "../src/cost.ts";
import { emptyUsage } from "../src/model.ts";
import { reportedCostApplies } from "../src/model-usage.ts";

export interface ModelTotals {
  provider: string;
  model: string;
  steps: number;
  input: number;
  /** Decant stores reasoning inside output; OpenCode reports it beside output. */
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Decant side only: `reported` when Decant has no rate for the model and
   * uses the cost OpenCode recorded, `list` when it prices the model. */
  costSource?: "list" | "reported";
}

export interface SessionTotals {
  sessionId: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ParityLine {
  level: "ok" | "mismatch" | "info";
  text: string;
}

/** Providers that record list prices, so Decant's rate should reproduce them. */
const LIST_PRICE_PROVIDERS = new Set(["zai", "meta", "opencode", "opencode-go", "openrouter"]);
const COST_TOLERANCE = 0.005;
/** A reported cost is OpenCode's own figure summed in another order. */
const REPORTED_COST_TOLERANCE = 1e-9;

const modelKey = (row: { provider: string; model: string }): string =>
  `${row.provider}/${row.model}`;

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(7);
}

/** Steps and the five token fields must match exactly. Decant's output is
 * compared with the reference output plus reasoning. */
export function compareModelTotals(
  decant: ModelTotals[],
  reference: ModelTotals[],
  label: string,
): ParityLine[] {
  const lines: ParityLine[] = [];
  const byKey = new Map(decant.map((row) => [modelKey(row), row]));
  const seen = new Set<string>();
  for (const expected of [...reference].sort((a, b) => modelKey(a).localeCompare(modelKey(b)))) {
    const key = modelKey(expected);
    seen.add(key);
    const actual = byKey.get(key);
    if (actual == null) {
      lines.push({
        level: "mismatch",
        text: `${key}: missing in Decant (${label} has ${expected.steps} steps)`,
      });
      continue;
    }
    const diffs: string[] = [];
    const check = (field: string, got: number, want: number): void => {
      if (got !== want) {
        diffs.push(`${field} ${fmt(got)} vs ${fmt(want)}`);
      }
    };
    check("steps", actual.steps, expected.steps);
    check("input", actual.input, expected.input);
    check("output", actual.output, expected.output + expected.reasoning);
    check("reasoning", actual.reasoning, expected.reasoning);
    check("cacheRead", actual.cacheRead, expected.cacheRead);
    check("cacheWrite", actual.cacheWrite, expected.cacheWrite);
    lines.push(
      diffs.length === 0
        ? { level: "ok", text: `${key}: ${actual.steps} steps, tokens match ${label}` }
        : { level: "mismatch", text: `${key}: ${diffs.join(", ")} (Decant vs ${label})` },
    );
  }
  for (const row of decant) {
    if (!seen.has(modelKey(row))) {
      lines.push({
        level: "mismatch",
        text: `${modelKey(row)}: missing in ${label} (Decant has ${row.steps} steps)`,
      });
    }
  }
  return lines;
}

/** Decant's cost against the cost OpenCode recorded. A model Decant cannot
 * price carries the recorded cost, so it must equal it whatever the provider.
 * A priced model is compared at list price for list-price providers; other
 * providers, and recorded zeros (free or subscription routes), are
 * informational. */
export function compareRecordedCost(decant: ModelTotals[], reference: ModelTotals[]): ParityLine[] {
  const lines: ParityLine[] = [];
  const byKey = new Map(decant.map((row) => [modelKey(row), row]));
  for (const expected of [...reference].sort((a, b) => modelKey(a).localeCompare(modelKey(b)))) {
    const key = modelKey(expected);
    const actual = byKey.get(key);
    if (actual == null) {
      continue;
    }
    if (actual.costSource === "reported") {
      if (expected.cost <= 0 && actual.cost <= 0) {
        lines.push({
          level: "info",
          text: `${key}: no Decant rate and no recorded cost (cost unavailable)`,
        });
        continue;
      }
      const equal = Math.abs(actual.cost - expected.cost) <= REPORTED_COST_TOLERANCE;
      lines.push({
        level: equal ? "ok" : "mismatch",
        text: `${key}: Decant reported ${fmt(actual.cost)} vs recorded ${fmt(expected.cost)} (no Decant rate)`,
      });
      continue;
    }
    if (!LIST_PRICE_PROVIDERS.has(expected.provider) || expected.cost <= 0) {
      lines.push({
        level: "info",
        text: `${key}: recorded ${fmt(expected.cost)}, Decant ${fmt(actual.cost)} (not compared)`,
      });
      continue;
    }
    const gap = Math.abs(actual.cost - expected.cost) / expected.cost;
    lines.push({
      level: gap <= COST_TOLERANCE ? "ok" : "mismatch",
      text: `${key}: Decant ${fmt(actual.cost)} vs recorded ${fmt(expected.cost)} (${(gap * 100).toFixed(2)}%)`,
    });
  }
  return lines;
}

/** Per session, Decant's assistant-only totals must not exceed session_v2's.
 * A lower figure is expected: title generation is counted only there. */
export function compareSessionTotals(
  decant: SessionTotals[],
  reference: SessionTotals[],
): ParityLine[] {
  const lines: ParityLine[] = [];
  const byId = new Map(decant.map((row) => [row.sessionId, row]));
  for (const expected of [...reference].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
    const actual = byId.get(expected.sessionId);
    if (actual == null) {
      lines.push({ level: "mismatch", text: `${expected.sessionId}: missing in Decant` });
      continue;
    }
    const over: string[] = [];
    const check = (field: string, got: number, want: number): void => {
      if (got > want) {
        over.push(`${field} ${fmt(got)} > ${fmt(want)}`);
      }
    };
    check("input", actual.input, expected.input);
    check("output", actual.output, expected.output + expected.reasoning);
    check("reasoning", actual.reasoning, expected.reasoning);
    check("cacheRead", actual.cacheRead, expected.cacheRead);
    check("cacheWrite", actual.cacheWrite, expected.cacheWrite);
    lines.push(
      over.length === 0
        ? { level: "ok", text: `${expected.sessionId}: Decant totals at or below session_v2` }
        : { level: "mismatch", text: `${expected.sessionId}: ${over.join(", ")}` },
    );
  }
  return lines;
}

/** `opencode stats --all --json`: `models[]` with `model.{providerID,id,variant}`,
 * `steps`, `tokens.{input,output,reasoning,cache.{read,write}}`, `cost`.
 * Variants of one model are summed into one line. */
export function parseStatsJson(text: string): ModelTotals[] {
  const parsed = JSON.parse(text) as { models?: unknown };
  if (!Array.isArray(parsed.models)) {
    throw new Error("stats JSON has no `models` array");
  }
  const totals = new Map<string, ModelTotals>();
  for (const entry of parsed.models as Array<{
    model: { providerID: string; id: string };
    steps: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    cost: number;
  }>) {
    const row = totals.get(`${entry.model.providerID}/${entry.model.id}`) ?? {
      provider: entry.model.providerID,
      model: entry.model.id,
      steps: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    };
    row.steps += entry.steps;
    row.input += entry.tokens.input;
    row.output += entry.tokens.output;
    row.reasoning += entry.tokens.reasoning;
    row.cacheRead += entry.tokens.cache.read;
    row.cacheWrite += entry.tokens.cache.write;
    row.cost += entry.cost;
    totals.set(`${row.provider}/${row.model}`, row);
  }
  return [...totals.values()];
}

interface OpenCodeModelRow {
  provider: string | null;
  model: string | null;
  steps: number;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  cost: number;
}

/** Assistant rows only, with OpenCode's own fork predicate. */
function readOpenCodeModelTotals(db: Database): ModelTotals[] {
  return (
    db
      .query(
        `SELECT json_extract(m.data, '$.model.providerID') AS provider,
                json_extract(m.data, '$.model.id') AS model,
                COUNT(*) AS steps,
                COALESCE(SUM(json_extract(m.data, '$.tokens.input')), 0) AS input,
                COALESCE(SUM(json_extract(m.data, '$.tokens.output')), 0) AS output,
                COALESCE(SUM(json_extract(m.data, '$.tokens.reasoning')), 0) AS reasoning,
                COALESCE(SUM(json_extract(m.data, '$.tokens.cache.read')), 0) AS cache_read,
                COALESCE(SUM(json_extract(m.data, '$.tokens.cache.write')), 0) AS cache_write,
                COALESCE(SUM(json_extract(m.data, '$.cost')), 0) AS cost
           FROM session_message m
           JOIN session_v2 s ON s.id = m.session_id
          WHERE m.type = 'assistant'
            AND json_type(m.data, '$.tokens') IS NOT NULL
            AND (s.fork_session_id IS NULL OR m.time_created >= s.time_created)
          GROUP BY 1, 2`,
      )
      .all() as OpenCodeModelRow[]
  ).map((row) => ({
    provider: row.provider ?? "",
    model: row.model ?? "",
    steps: row.steps,
    input: row.input,
    output: row.output,
    reasoning: row.reasoning,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    cost: row.cost,
  }));
}

function readOpenCodeCompaction(db: Database): { rows: number; input: number; output: number } {
  return db
    .query(
      `SELECT COUNT(*) AS rows,
              COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) AS input,
              COALESCE(SUM(json_extract(data, '$.tokens.output')), 0)
                + COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0) AS output
         FROM session_message WHERE type = 'compaction'`,
    )
    .get() as { rows: number; input: number; output: number };
}

function readOpenCodeSessionTotals(db: Database): SessionTotals[] {
  return db
    .query(
      `SELECT id AS sessionId, tokens_input AS input, tokens_output AS output,
                tokens_reasoning AS reasoning, tokens_cache_read AS cacheRead,
                tokens_cache_write AS cacheWrite, cost
           FROM session_v2`,
    )
    .all() as SessionTotals[];
}

/** One Decant provider/model group before costing. `recorded` is the
 * positive cost OpenCode recorded on those messages, used only to share a
 * model's reported cost among providers that served it. */
export interface DecantModelGroup extends Omit<ModelTotals, "reasoning" | "cost" | "costSource"> {
  recorded: number;
}

/** Costs each group as Decant does: a priced model at list price, and a
 * model Decant cannot price at the reported cost the archive stores for it
 * (`session_model_usage.reported_cost_usd`, keyed by model alone), shared by
 * recorded cost when several providers served the model. */
export function costDecantModelGroups(
  groups: readonly DecantModelGroup[],
  reportedByModel: ReadonlyMap<string, number>,
): ModelTotals[] {
  const pricing = defaultPricing();
  const recordedByModel = new Map<string, { recorded: number; groups: number }>();
  for (const group of groups) {
    const entry = recordedByModel.get(group.model) ?? { recorded: 0, groups: 0 };
    entry.recorded += group.recorded;
    entry.groups += 1;
    recordedByModel.set(group.model, entry);
  }
  return groups.map(({ recorded, ...group }) => {
    const base = { ...group, reasoning: 0 };
    if (!reportedCostApplies(group.model, 0)) {
      const usage = {
        ...emptyUsage(),
        input: group.input,
        output: group.output,
        cacheRead: group.cacheRead,
        cacheCreation: group.cacheWrite,
      };
      return { ...base, cost: estimateCost(group.model, usage, pricing), costSource: "list" };
    }
    const reported = reportedByModel.get(group.model) ?? 0;
    const share = recordedByModel.get(group.model) ?? { recorded: 0, groups: 1 };
    const cost =
      share.recorded > 0 ? (reported * recorded) / share.recorded : reported / share.groups;
    return { ...base, cost, costSource: "reported" };
  });
}

/** Decant assistant messages of OpenCode sessions grouped by the provider in
 * the message's raw record and the model that served it. Reasoning is kept
 * only per session in the archive, so the per-model reasoning figure comes
 * from the reference side alone and Decant reports 0 here; the per-model
 * comparison therefore checks output (which contains reasoning), not the
 * reasoning field. */
function readDecantModelTotals(db: Database): ModelTotals[] {
  const groups = (
    db
      .query(
        `SELECT json_extract(m.raw, '$.model.providerID') AS provider,
                m.model AS model,
                COUNT(*) AS steps,
                COALESCE(SUM(m.input_tokens), 0) AS input,
                COALESCE(SUM(m.output_tokens), 0) AS output,
                COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read,
                COALESCE(SUM(m.cache_creation_tokens), 0) AS cache_write,
                COALESCE(SUM(CASE WHEN json_extract(m.raw, '$.cost') > 0
                                  THEN json_extract(m.raw, '$.cost') END), 0) AS recorded
           FROM message m
           JOIN session s ON s.id = m.session_id
          WHERE s.tool = 'opencode' AND m.role = 'assistant' AND m.input_tokens IS NOT NULL
          GROUP BY 1, 2`,
      )
      .all() as Array<Omit<OpenCodeModelRow, "reasoning" | "cost"> & { recorded: number }>
  ).map((row) => ({
    provider: row.provider ?? "",
    model: row.model ?? "",
    steps: row.steps,
    input: row.input,
    output: row.output,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    recorded: row.recorded,
  }));
  const reported = db
    .query(
      `SELECT u.model AS model, SUM(u.reported_cost_usd) AS cost
         FROM session_model_usage u
         JOIN session s ON s.id = u.session_id
        WHERE s.tool = 'opencode' AND u.reported_cost_usd IS NOT NULL
        GROUP BY u.model`,
    )
    .all() as Array<{ model: string; cost: number }>;
  return costDecantModelGroups(
    groups,
    new Map(
      reported
        .filter((row) => reportedCostApplies(row.model, row.cost))
        .map((row) => [row.model, row.cost]),
    ),
  );
}

function readDecantSessionTotals(db: Database): SessionTotals[] {
  return db
    .query(
      `SELECT s.source_session_id AS sessionId,
                COALESCE(SUM(m.input_tokens), 0) AS input,
                COALESCE(SUM(m.output_tokens), 0) AS output,
                s.total_reasoning_tokens AS reasoning,
                COALESCE(SUM(m.cache_read_tokens), 0) AS cacheRead,
                COALESCE(SUM(m.cache_creation_tokens), 0) AS cacheWrite,
                s.estimated_cost_usd AS cost
           FROM session s
           LEFT JOIN message m ON m.session_id = s.id AND m.role = 'assistant'
          WHERE s.tool = 'opencode'
          GROUP BY s.id`,
    )
    .all() as SessionTotals[];
}

function openReadOnly(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

function print(lines: ParityLine[]): number {
  let mismatches = 0;
  for (const line of lines) {
    mismatches += line.level === "mismatch" ? 1 : 0;
    console.log(`${line.level.padEnd(8)} ${line.text}`);
  }
  return mismatches;
}

function main(): void {
  const [opencodePath, decantPath, statsPath] = process.argv.slice(2);
  if (opencodePath == null || decantPath == null) {
    console.error(
      "usage: bun run scripts/opencode-parity.ts <opencode.db> <decant.db> [stats.json]",
    );
    process.exit(2);
  }
  const opencode = openReadOnly(opencodePath);
  const decant = openReadOnly(decantPath);
  try {
    const decantModels = readDecantModelTotals(decant);
    const openCodeModels = readOpenCodeModelTotals(opencode);
    // Decant keeps reasoning per session, so per-model reasoning is not
    // comparable field by field; drop it from the reference for this pass.
    const perModelReference = openCodeModels.map((row) => ({
      ...row,
      reasoning: 0,
      output: row.output + row.reasoning,
    }));
    let mismatches = 0;
    console.log(`== per provider/model: Decant vs ${opencodePath}`);
    mismatches += print(compareModelTotals(decantModels, perModelReference, "opencode.db"));
    console.log("== Decant cost vs recorded cost");
    mismatches += print(compareRecordedCost(decantModels, openCodeModels));
    const compaction = readOpenCodeCompaction(opencode);
    console.log(
      `info     compaction rows ${compaction.rows}: input ${compaction.input}, output ${compaction.output} (counted by Decant, not by opencode stats)`,
    );
    console.log("== per session: Decant assistant-only vs session_v2");
    mismatches += print(
      compareSessionTotals(readDecantSessionTotals(decant), readOpenCodeSessionTotals(opencode)),
    );
    if (statsPath != null) {
      const stats = parseStatsJson(readFileSync(statsPath, "utf8"));
      console.log(`== per provider/model: Decant vs ${statsPath}`);
      mismatches += print(
        compareModelTotals(
          decantModels,
          stats.map((row) => ({ ...row, reasoning: 0, output: row.output + row.reasoning })),
          "stats.json",
        ),
      );
    }
    console.log(`== ${mismatches} mismatch line(s)`);
    process.exitCode = mismatches === 0 ? 0 : 1;
  } finally {
    decant.close();
    opencode.close();
  }
}

if (import.meta.main) {
  main();
}
