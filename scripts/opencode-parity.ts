// Developer-only parity check between an OpenCode database (2.x tables, 1.x
// tables, or both), a Decant archive synced from it, and optionally the JSON
// the user produced by running `opencode stats --all --json` against their own
// OpenCode 2.x. Prints aggregate counts and totals only, never transcript
// text, tool input, or tool output.
//
// SAFETY: this script never starts the OpenCode CLI or service. Running
// OpenCode against a copied database resumes in-progress sessions with the
// stored credentials and makes real, billed model calls. Both databases are
// opened read-only.
//
// `--letta` adds a structural cross-check of every session read from the 1.x
// tables against Letta's `@letta-ai/trajectory` OpenCode adapter (a
// devDependency, never imported from src/). The adapter reads the 1.x
// `opencode export` layout, which this script assembles from the tables
// itself; normalization is pure, with no filesystem or network access.
//
// Usage: bun run scripts/opencode-parity.ts <opencode.db> <decant.db> [stats.json] [--letta]
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  type Diagnostic,
  NormalizationError,
  type NormalizedRecord,
  normalizeTranscript,
} from "@letta-ai/trajectory";
import { defaultPricing, estimateCost } from "../src/cost.ts";
import { isObject, type JsonObject } from "../src/json.ts";
import { MESSAGE_METADATA_SQL } from "../src/message-storage.ts";
import { emptyUsage, type Json, type TokenUsage } from "../src/model.ts";
import { reportedCostApplies } from "../src/model-usage.ts";
import type {
  OpenCodeLegacyMessageRow,
  OpenCodeLegacyPartRow,
} from "../src/sources/opencode-legacy.ts";
import {
  legacyAssistantUsage,
  openCodeUsage,
  reasoningOverlap,
} from "../src/sources/opencode-usage.ts";

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
  /** Reference side only: reasoning tokens counted inside output by a release
   * before 1.3.16, which also charged them again at the output rate, so the
   * recorded cost exceeds the list price by that much. */
  doubleCharged?: number;
}

export interface SessionTotals {
  sessionId: string;
  /** OpenCode migrated the session from 1.x and its 1.x copy still holds
   * messages, so session_v2's aggregates sum last-step tokens only. */
  migrated?: boolean;
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
  actualLabel = "Decant",
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
        text: `${key}: missing in ${actualLabel} (${label} has ${expected.steps} steps)`,
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
        : { level: "mismatch", text: `${key}: ${diffs.join(", ")} (${actualLabel} vs ${label})` },
    );
  }
  for (const row of decant) {
    if (!seen.has(modelKey(row))) {
      lines.push({
        level: "mismatch",
        text: `${modelKey(row)}: missing in ${label} (${actualLabel} has ${row.steps} steps)`,
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
    // Releases before 1.3.16 charged reasoning held inside output a second
    // time; Decant charges it once, so that excess is taken off the record.
    const excess =
      (expected.doubleCharged ?? 0) > 0
        ? estimateCost(
            expected.model,
            { ...emptyUsage(), output: expected.doubleCharged ?? 0 },
            defaultPricing(),
          )
        : 0;
    const recorded = expected.cost - excess;
    const gap = Math.abs(actual.cost - recorded) / recorded;
    const note = excess > 0 ? `, less ${fmt(excess)} reasoning charged twice before 1.3.16` : "";
    lines.push({
      level: gap <= COST_TOLERANCE ? "ok" : "mismatch",
      text: `${key}: Decant ${fmt(actual.cost)} vs recorded ${fmt(expected.cost)}${note} (${(gap * 100).toFixed(2)}%)`,
    });
  }
  return lines;
}

/** Per session, Decant's assistant-only totals must not exceed session_v2's.
 * A lower figure is expected: title generation is counted only there. A
 * session migrated from 1.x is informational: its aggregates hold each
 * migrated message's last step only, and Decant reads every step. */
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
        : expected.migrated === true
          ? {
              level: "info",
              text: `${expected.sessionId}: ${over.join(", ")} (migrated from 1.x; session_v2 sums last steps only)`,
            }
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

function hasTable(db: Database, name: string): boolean {
  return (
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1").get(name) != null
  );
}

/** The 1.x tables, in a database that is not a pre-split 2.x preview
 * (`session_message` without `session_v2`), whose `session` rows are 2.x. */
function hasLegacyTables(db: Database): boolean {
  if (hasTable(db, "session_message") && !hasTable(db, "session_v2")) {
    return false;
  }
  return ["session", "message", "part"].every((table) => hasTable(db, table));
}

/** SQL that is true when a 1.x copy of `<alias>.id` was updated after the
 * session_v2 row, so Decant reads the session from the 1.x tables. A tie goes
 * to the 2.x copy. */
function legacyNewerSql(db: Database, alias: string): string {
  return hasLegacyTables(db)
    ? `EXISTS (SELECT 1 FROM session l WHERE l.id = ${alias}.id AND l.time_updated > ${alias}.time_updated)`
    : "0";
}

/** SQL that is true when `<alias>.id` has a 1.x copy holding messages: a
 * session OpenCode migrated whose 1.x tables are intact, so Decant corrects
 * its migrated rows from them. */
function migratedSql(db: Database, alias: string): string {
  return hasLegacyTables(db)
    ? `EXISTS (SELECT 1 FROM message l WHERE l.session_id = ${alias}.id)`
    : "0";
}

function parseObject(text: string | null): JsonObject | null {
  if (text == null) {
    return null;
  }
  try {
    const value = JSON.parse(text) as Json;
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function numberOr0(value: Json | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOrEmpty(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}

interface TokenFields {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

function accumulate(
  totals: Map<string, ModelTotals>,
  key: { provider: string; model: string },
  fields: TokenFields,
  cost: number,
  doubleCharged = 0,
): void {
  const row = totals.get(modelKey(key)) ?? {
    provider: key.provider,
    model: key.model,
    steps: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  row.steps += 1;
  row.input += fields.input;
  row.output += fields.output;
  row.reasoning += fields.reasoning;
  row.cacheRead += fields.cacheRead;
  row.cacheWrite += fields.cacheWrite;
  row.cost += cost;
  if (doubleCharged > 0) {
    row.doubleCharged = (row.doubleCharged ?? 0) + doubleCharged;
  }
  totals.set(modelKey(key), row);
}

/** Reasoning a tokens object holds inside output, by the 1.x release rule. */
function reasoningInsideOutput(tokens: JsonObject, version: string | null): number {
  return reasoningOverlap(tokens, version) === "included"
    ? (openCodeUsage(tokens, "included")?.reasoning ?? 0)
    : 0;
}

/** A 1.x assistant message's usage (`legacyAssistantUsage`) and the reasoning
 * its steps held inside output, which a release before 1.3.16 also charged a
 * second time in the message's recorded cost. */
export function legacyUsage(
  info: JsonObject,
  parts: readonly Json[],
  version: string | null,
): { usage: TokenUsage; doubleCharged: number } | null {
  const usage = legacyAssistantUsage(info, parts, version);
  if (usage == null) {
    return null;
  }
  const steps = parts.flatMap((part) =>
    isObject(part) && part.type === "step-finish" && isObject(part.tokens) ? [part.tokens] : [],
  );
  const sources = steps.length > 0 ? steps : isObject(info.tokens) ? [info.tokens] : [];
  const doubleCharged = sources.reduce(
    (sum, tokens) => sum + reasoningInsideOutput(tokens, version),
    0,
  );
  return { usage, doubleCharged };
}

/** Sums reference totals from several readers by provider/model. */
export function mergeModelTotals(...lists: readonly ModelTotals[][]): ModelTotals[] {
  const merged = new Map<string, ModelTotals>();
  for (const row of lists.flat()) {
    const existing = merged.get(modelKey(row));
    merged.set(
      modelKey(row),
      existing == null
        ? { ...row }
        : {
            ...existing,
            steps: existing.steps + row.steps,
            input: existing.input + row.input,
            output: existing.output + row.output,
            reasoning: existing.reasoning + row.reasoning,
            cacheRead: existing.cacheRead + row.cacheRead,
            cacheWrite: existing.cacheWrite + row.cacheWrite,
            cost: existing.cost + row.cost,
            ...(existing.doubleCharged != null || row.doubleCharged != null
              ? { doubleCharged: (existing.doubleCharged ?? 0) + (row.doubleCharged ?? 0) }
              : {}),
          },
    );
  }
  return [...merged.values()].sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

/** Decant keeps reasoning per session, so per-model reasoning is not
 * comparable field by field; fold it into output for the per-model pass. */
function withReasoningInOutput(rows: readonly ModelTotals[]): ModelTotals[] {
  return rows.map((row) => ({ ...row, output: row.output + row.reasoning, reasoning: 0 }));
}

/** One 2.x assistant row, with what each counting rule needs. */
export interface OpenCodeAssistantRow {
  id: string;
  sessionId: string;
  provider: string;
  model: string;
  tokens: JsonObject;
  cost: number;
  /** The release that created the session (`session_v2.version`). */
  version: string | null;
  /** Older than its session: history a fork copied from its parent. */
  inherited: boolean;
  /** The session records the session it forked from (`fork_session_id`). */
  forkLinked: boolean;
  /** A newer 1.x copy of the session exists, and Decant reads that one. */
  legacyPreferred: boolean;
  /** The session's 1.x copy holds messages: OpenCode migrated it. */
  migrated: boolean;
  /** This row's usage summed from its 1.x step-finish parts, when the 1.x
   * copy holds the message (the migrator kept only the last step's tokens). */
  stepSum: { usage: TokenUsage; doubleCharged: number } | null;
}

interface OpenCodeAssistantDbRow {
  id: string;
  session_id: string;
  provider: string | null;
  model: string | null;
  tokens: string;
  cost: number | null;
  version: string | null;
  inherited: number;
  fork_linked: number;
  legacy_preferred: number;
  migrated: number;
}

export function readOpenCodeAssistantRows(db: Database): OpenCodeAssistantRow[] {
  if (!hasTable(db, "session_v2") || !hasTable(db, "session_message")) {
    return [];
  }
  const rows = db
    .query(
      `SELECT m.id, m.session_id,
              json_extract(m.data, '$.model.providerID') AS provider,
              json_extract(m.data, '$.model.id') AS model,
              json_extract(m.data, '$.tokens') AS tokens,
              json_extract(m.data, '$.cost') AS cost,
              s.version AS version,
              m.time_created < s.time_created AS inherited,
              s.fork_session_id IS NOT NULL AS fork_linked,
              ${legacyNewerSql(db, "s")} AS legacy_preferred,
              ${migratedSql(db, "s")} AS migrated
         FROM session_message m
         JOIN session_v2 s ON s.id = m.session_id
        WHERE m.type = 'assistant' AND json_type(m.data, '$.tokens') = 'object'`,
    )
    .all() as OpenCodeAssistantDbRow[];
  const stepSums = new Map<
    string,
    ReadonlyMap<string, { usage: TokenUsage; doubleCharged: number } | null>
  >();
  for (const sessionId of new Set(rows.filter((r) => r.migrated === 1).map((r) => r.session_id))) {
    stepSums.set(sessionId, legacyStepSums(db, sessionId));
  }
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    provider: row.provider ?? "",
    model: row.model ?? "",
    tokens: parseObject(row.tokens) ?? {},
    cost: typeof row.cost === "number" ? row.cost : 0,
    version: row.version,
    inherited: row.inherited === 1,
    forkLinked: row.fork_linked === 1,
    legacyPreferred: row.legacy_preferred === 1,
    migrated: row.migrated === 1,
    stepSum: stepSums.get(row.session_id)?.get(row.id) ?? null,
  }));
}

/** Each 1.x assistant message's usage by id: the sum of its step-finish
 * parts under the 1.x release rule. */
function legacyStepSums(
  db: Database,
  sessionId: string,
): Map<string, { usage: TokenUsage; doubleCharged: number } | null> {
  const version =
    (
      db.query("SELECT version FROM session WHERE id = ?1").get(sessionId) as {
        version: string | null;
      } | null
    )?.version ?? null;
  const { messages, parts } = loadLegacyRows(db, sessionId);
  const sums = new Map<string, { usage: TokenUsage; doubleCharged: number } | null>();
  for (const message of legacyMessages({ time_created: 0 }, messages, parts)) {
    if (message.info.role === "assistant") {
      sums.set(message.id, legacyUsage(message.info, message.parts, version));
    }
  }
  return sums;
}

/** Per-model totals of 2.x assistant rows under one counting rule. Both keep
 * OpenCode's convention: `output` excludes reasoning, reported beside it.
 *
 * `decant` is what Decant ingests. It skips every row older than its session,
 * because a fork copies its parent's rows with their original times, and a
 * session OpenCode migrated from 1.x records no fork link. It classifies
 * reasoning with the 1.x rule, because a migrated row created before OpenCode
 * 1.3.16 already counts reasoning inside output. It skips sessions read from a
 * newer 1.x copy. In a session whose 1.x copy is intact, a migrated row's
 * usage is the sum of its 1.x step-finish parts (the migrator copied only the
 * last step's tokens), and a row without a 1.x message was written by 2.x
 * after the migration, so it is disjoint.
 *
 * `stats` is what `opencode stats` sums: it skips inherited rows only when the
 * session records `fork_session_id`, and adds reasoning to output as stored.
 * The two differ by design for migrated forks and migrated pre-1.3.16 rows. */
export function openCodeModelTotals(
  rows: readonly OpenCodeAssistantRow[],
  rule: "decant" | "stats",
): ModelTotals[] {
  const totals = new Map<string, ModelTotals>();
  for (const row of rows) {
    if (rule === "decant") {
      if (row.legacyPreferred || row.inherited) {
        continue;
      }
      const usage =
        row.stepSum?.usage ??
        openCodeUsage(
          row.tokens,
          row.migrated ? "disjoint" : reasoningOverlap(row.tokens, row.version),
        ) ??
        emptyUsage();
      const doubleCharged =
        row.stepSum?.doubleCharged ??
        (row.migrated ? 0 : reasoningInsideOutput(row.tokens, row.version));
      accumulate(
        totals,
        row,
        {
          input: usage.input,
          output: usage.output - usage.reasoning,
          reasoning: usage.reasoning,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheCreation,
        },
        row.cost,
        doubleCharged,
      );
      continue;
    }
    if (row.inherited && row.forkLinked) {
      continue;
    }
    const cache = isObject(row.tokens.cache) ? row.tokens.cache : {};
    accumulate(
      totals,
      row,
      {
        input: numberOr0(row.tokens.input),
        output: numberOr0(row.tokens.output),
        reasoning: numberOr0(row.tokens.reasoning),
        cacheRead: numberOr0(cache.read),
        cacheWrite: numberOr0(cache.write),
      },
      row.cost,
    );
  }
  return [...totals.values()];
}

/** Rows `opencode stats` counts differently from Decant, by reason. */
export function openCodeRuleDifferences(rows: readonly OpenCodeAssistantRow[]): {
  inheritedWithoutForkLink: number;
  legacyPreferred: number;
  reasoningIncluded: number;
  stepSums: number;
} {
  let inheritedWithoutForkLink = 0;
  let legacyPreferred = 0;
  let reasoningIncluded = 0;
  let stepSums = 0;
  for (const row of rows) {
    if (row.inherited && row.forkLinked) {
      continue;
    }
    if (row.legacyPreferred) {
      legacyPreferred += 1;
    } else if (row.inherited) {
      inheritedWithoutForkLink += 1;
    } else if (row.stepSum != null) {
      stepSums += 1;
    } else if (!row.migrated && reasoningOverlap(row.tokens, row.version) === "included") {
      reasoningIncluded += 1;
    }
  }
  return { inheritedWithoutForkLink, legacyPreferred, reasoningIncluded, stepSums };
}

function readOpenCodeCompaction(db: Database): { rows: number; input: number; output: number } {
  if (!hasTable(db, "session_v2") || !hasTable(db, "session_message")) {
    return { rows: 0, input: 0, output: 0 };
  }
  return db
    .query(
      `SELECT COUNT(*) AS rows,
              COALESCE(SUM(json_extract(m.data, '$.tokens.input')), 0) AS input,
              COALESCE(SUM(json_extract(m.data, '$.tokens.output')), 0)
                + COALESCE(SUM(json_extract(m.data, '$.tokens.reasoning')), 0) AS output
         FROM session_message m
         JOIN session_v2 s ON s.id = m.session_id
        WHERE m.type = 'compaction' AND NOT ${legacyNewerSql(db, "s")}`,
    )
    .get() as { rows: number; input: number; output: number };
}

function readOpenCodeSessionTotals(db: Database): SessionTotals[] {
  if (!hasTable(db, "session_v2")) {
    return [];
  }
  const rows = db
    .query(
      `SELECT s.id AS sessionId, ${migratedSql(db, "s")} AS migrated,
              s.tokens_input AS input, s.tokens_output AS output,
              s.tokens_reasoning AS reasoning, s.tokens_cache_read AS cacheRead,
              s.tokens_cache_write AS cacheWrite, s.cost
         FROM session_v2 s
        WHERE NOT ${legacyNewerSql(db, "s")}`,
    )
    .all() as Array<Omit<SessionTotals, "migrated"> & { migrated: number }>;
  return rows.map((row) => ({ ...row, migrated: row.migrated === 1 }));
}

/** One 1.x session Decant reads from the 1.x tables. The aggregate columns
 * arrived in later 1.x releases and read as NULL on older databases. */
export interface LegacySession {
  id: string;
  directory: string | null;
  version: string | null;
  time_created: number;
  time_updated: number;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
}

const LEGACY_AGGREGATE_COLUMNS = [
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
] as const;

/** Sessions in the 1.x tables that Decant reads from there: absent from
 * session_v2, or updated there later than in session_v2 (a 1.x binary kept
 * writing after OpenCode 2.x migrated the session). A tie goes to 2.x. */
export function readLegacySessions(db: Database): LegacySession[] {
  if (!hasLegacyTables(db)) {
    return [];
  }
  const columns = new Set(
    (db.query("SELECT name FROM pragma_table_info('session')").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  const aggregates = LEGACY_AGGREGATE_COLUMNS.map((column) =>
    columns.has(column) ? `s."${column}"` : `NULL AS "${column}"`,
  ).join(", ");
  const precedence = hasTable(db, "session_v2")
    ? "LEFT JOIN session_v2 v ON v.id = s.id WHERE v.id IS NULL OR s.time_updated > v.time_updated"
    : "";
  return db
    .query(
      `SELECT s.id, s.directory, s.version, s.time_created, s.time_updated, ${aggregates}
         FROM session s ${precedence}
        ORDER BY s.id`,
    )
    .all() as LegacySession[];
}

function loadLegacyRows(
  db: Database,
  sessionId: string,
): { messages: OpenCodeLegacyMessageRow[]; parts: OpenCodeLegacyPartRow[] } {
  return db
    .transaction(() => ({
      messages: db
        .query(
          `SELECT id, session_id, time_created, time_updated, data
             FROM message WHERE session_id = ?1 ORDER BY time_created, id`,
        )
        .all(sessionId) as OpenCodeLegacyMessageRow[],
      parts: db
        .query(
          `SELECT id, message_id, session_id, time_created, time_updated, data
             FROM part WHERE session_id = ?1 ORDER BY message_id, id`,
        )
        .all(sessionId) as OpenCodeLegacyPartRow[],
    }))
    .deferred();
}

interface LegacyMessage {
  id: string;
  info: JsonObject;
  parts: JsonObject[];
}

/** The messages Decant reads, in OpenCode's order, each with its parts. 1.x
 * records no fork link: a fork copies its parent's messages with their
 * original creation time, so a message older than its session is inherited
 * history and is skipped. Unreadable rows are skipped too. */
function legacyMessages(
  session: Pick<LegacySession, "time_created">,
  messages: readonly OpenCodeLegacyMessageRow[],
  parts: readonly OpenCodeLegacyPartRow[],
): LegacyMessage[] {
  const kept = new Map<string, LegacyMessage>();
  for (const row of messages) {
    const info = row.time_created < session.time_created ? null : parseObject(row.data);
    if (info != null) {
      kept.set(row.id, { id: row.id, info: { ...info, id: row.id }, parts: [] });
    }
  }
  for (const row of parts) {
    const data = parseObject(row.data);
    const owner = kept.get(row.message_id);
    if (data != null && owner != null) {
      owner.parts.push({ ...data, id: row.id });
    }
  }
  return [...kept.values()];
}

/** Per-model totals of the 1.x sessions Decant reads, in OpenCode's
 * convention (`output` excludes reasoning, so `output + reasoning` is Decant's
 * output). One step per assistant message with recorded usage, summed from
 * its step-finish parts because 1.x keeps only the last step's tokens on the
 * message; reasoning is classified per tokens object by the 1.x release rule.
 * Compaction summaries are counted separately (`readLegacyCompaction`). Cost
 * is the message's recorded `cost`, which already sums its steps. */
export function readLegacyModelTotals(db: Database): ModelTotals[] {
  const totals = new Map<string, ModelTotals>();
  for (const session of readLegacySessions(db)) {
    const { messages, parts } = loadLegacyRows(db, session.id);
    for (const message of legacyMessages(session, messages, parts)) {
      if (message.info.role !== "assistant" || message.info.summary === true) {
        continue;
      }
      const counted = legacyUsage(message.info, message.parts, session.version);
      if (counted == null) {
        continue;
      }
      const { usage, doubleCharged } = counted;
      accumulate(
        totals,
        {
          provider: stringOrEmpty(message.info.providerID),
          model: stringOrEmpty(message.info.modelID),
        },
        {
          input: usage.input,
          output: usage.output - usage.reasoning,
          reasoning: usage.reasoning,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheCreation,
        },
        numberOr0(message.info.cost),
        doubleCharged,
      );
    }
  }
  return [...totals.values()].sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

/** 1.x compaction summaries (`summary: true` assistants): their own request's
 * usage, with output in Decant's convention (reasoning included). */
export function readLegacyCompaction(db: Database): {
  rows: number;
  input: number;
  output: number;
} {
  const result = { rows: 0, input: 0, output: 0 };
  for (const session of readLegacySessions(db)) {
    const { messages, parts } = loadLegacyRows(db, session.id);
    for (const message of legacyMessages(session, messages, parts)) {
      if (message.info.role === "assistant" && message.info.summary === true) {
        const usage = legacyAssistantUsage(message.info, message.parts, session.version);
        result.rows += 1;
        result.input += usage?.input ?? 0;
        result.output += usage?.output ?? 0;
      }
    }
  }
  return result;
}

/** The 1.x `session` aggregate columns, where the database has them. */
export function readLegacySessionTotals(db: Database): SessionTotals[] {
  return readLegacySessions(db)
    .filter((session) => session.tokens_input != null)
    .map((session) => ({
      sessionId: session.id,
      input: session.tokens_input ?? 0,
      output: session.tokens_output ?? 0,
      reasoning: session.tokens_reasoning ?? 0,
      cacheRead: session.tokens_cache_read ?? 0,
      cacheWrite: session.tokens_cache_write ?? 0,
      cost: session.cost ?? 0,
    }));
}

/** Informational only. 1.x session columns are not ground truth: a fork's
 * include the usage it inherited, and sessions created before OpenCode
 * 1.14.49 were backfilled from each message's last-step tokens. */
export function compareLegacySessionTotals(
  decant: SessionTotals[],
  reference: SessionTotals[],
): ParityLine[] {
  const lines: ParityLine[] = [];
  const byId = new Map(decant.map((row) => [row.sessionId, row]));
  let matched = 0;
  for (const expected of [...reference].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
    const actual = byId.get(expected.sessionId);
    if (actual == null) {
      lines.push({ level: "info", text: `${expected.sessionId}: not in Decant` });
      continue;
    }
    const diffs: string[] = [];
    const check = (field: string, got: number, want: number): void => {
      if (got !== want) {
        diffs.push(`${field} ${fmt(got)} vs ${fmt(want)}`);
      }
    };
    check("input", actual.input, expected.input);
    check("cacheRead", actual.cacheRead, expected.cacheRead);
    check("cacheWrite", actual.cacheWrite, expected.cacheWrite);
    matched += diffs.length === 0 ? 1 : 0;
    lines.push({
      level: "info",
      text:
        diffs.length === 0
          ? `${expected.sessionId}: input and cache match the session columns`
          : `${expected.sessionId}: ${diffs.join(", ")} (Decant vs session columns)`,
    });
  }
  lines.push({
    level: "info",
    text: `${matched} of ${reference.length} 1.x session(s) match on input/cache (fork and backfilled aggregates differ by design)`,
  });
  return lines;
}

/** The 1.x `opencode export` layout Letta's OpenCode adapter reads. */
export interface LegacyExport {
  info: JsonObject;
  messages: Array<{ info: JsonObject; parts: JsonObject[] }>;
}

/** Assembles what Decant reads of one 1.x session in the export layout:
 * user and assistant messages only, without inherited fork history, without a
 * compaction request and its summary (Decant folds the pair into one system
 * message), and without `synthetic` or `ignored` text, which Decant does not
 * show as user text (Letta's adapter would). */
export function buildLegacyExport(
  session: Pick<LegacySession, "id" | "directory" | "time_created">,
  messages: readonly OpenCodeLegacyMessageRow[],
  parts: readonly OpenCodeLegacyPartRow[],
): LegacyExport {
  const kept = legacyMessages(session, messages, parts);
  const compactionRequests = new Set(
    kept
      .filter(
        (message) =>
          message.info.role === "user" && message.parts.some((part) => part.type === "compaction"),
      )
      .map((message) => message.id),
  );
  return {
    info: { id: session.id, directory: session.directory, time: { created: session.time_created } },
    messages: kept
      .filter((message) =>
        message.info.role === "user"
          ? !compactionRequests.has(message.id)
          : message.info.role === "assistant" && message.info.summary !== true,
      )
      .map((message) => ({
        info: message.info,
        parts: message.parts.filter(
          (part) => !(part.type === "text" && (part.synthetic === true || part.ignored === true)),
        ),
      })),
  };
}

export type ToolOutcome = "ok" | "error" | "none";

/** What the structural cross-check compares: tool calls by id with their name
 * and result flag (`none` = no result, or no authoritative outcome), and
 * record counts. */
export interface TranscriptStructure {
  toolCalls: Map<string, { name: string; outcome: ToolOutcome }>;
  user: number;
  assistantText: number;
  reasoning: number;
}

export function lettaStructure(records: readonly NormalizedRecord[]): TranscriptStructure {
  const structure: TranscriptStructure = {
    toolCalls: new Map(),
    user: 0,
    assistantText: 0,
    reasoning: 0,
  };
  const outcomes = new Map<string, ToolOutcome>();
  for (const record of records) {
    if (record.role === "user") {
      structure.user += 1;
    } else if (record.role === "reasoning") {
      structure.reasoning += 1;
    } else if (record.role === "assistant") {
      if ("tool_calls" in record) {
        for (const call of record.tool_calls) {
          structure.toolCalls.set(call.id, { name: call.name, outcome: "none" });
        }
      } else {
        structure.assistantText += 1;
      }
    } else if (record.role === "tool") {
      outcomes.set(
        record.tool_call_id,
        record.ok === true ? "ok" : record.ok === false ? "error" : "none",
      );
    }
  }
  for (const [id, outcome] of outcomes) {
    const call = structure.toolCalls.get(id);
    if (call != null) {
      call.outcome = outcome;
    }
  }
  return structure;
}

/** Decant names an MCP call `mcp__<server>__<tool>`; OpenCode (and Letta)
 * keep `<server>_<tool>`. A sanitized server name may itself hold `__`, so
 * every split is tried. */
export function toolNamesMatch(decantName: string, lettaName: string): boolean {
  if (decantName === lettaName) {
    return true;
  }
  if (!decantName.startsWith("mcp__")) {
    return false;
  }
  const rest = decantName.slice("mcp__".length);
  for (let at = rest.indexOf("__"); at > 0; at = rest.indexOf("__", at + 1)) {
    if (`${rest.slice(0, at)}_${rest.slice(at + 2)}` === lettaName) {
      return true;
    }
  }
  return false;
}

/** Tool-call ids, names, and result flags must match exactly; record counts
 * are informational (Letta keeps empty text, and Decant's system messages for
 * subtasks have no Letta counterpart). */
export function compareStructure(
  sessionId: string,
  decant: TranscriptStructure,
  letta: TranscriptStructure,
): ParityLine[] {
  const lines: ParityLine[] = [];
  const onlyLetta = [...letta.toolCalls.keys()].filter((id) => !decant.toolCalls.has(id));
  const onlyDecant = [...decant.toolCalls.keys()].filter((id) => !letta.toolCalls.has(id));
  let names = 0;
  let outcomes = 0;
  for (const [id, call] of decant.toolCalls) {
    const other = letta.toolCalls.get(id);
    if (other == null) {
      continue;
    }
    names += toolNamesMatch(call.name, other.name) ? 0 : 1;
    outcomes += call.outcome === other.outcome ? 0 : 1;
  }
  if (onlyLetta.length > 0 || onlyDecant.length > 0) {
    lines.push({
      level: "mismatch",
      text: `${sessionId}: tool-call ids differ (${onlyLetta.length} only in Letta, ${onlyDecant.length} only in Decant)`,
    });
  }
  if (names > 0) {
    lines.push({
      level: "mismatch",
      text: `${sessionId}: ${names} tool name(s) differ from Letta`,
    });
  }
  if (outcomes > 0) {
    lines.push({
      level: "mismatch",
      text: `${sessionId}: ${outcomes} tool result flag(s) differ from Letta`,
    });
  }
  if (lines.length === 0) {
    lines.push({
      level: "ok",
      text: `${sessionId}: ${decant.toolCalls.size} tool call(s) match Letta (ids, names, results)`,
    });
  }
  lines.push({
    level: "info",
    text: `${sessionId}: records Decant/Letta user ${decant.user}/${letta.user}, assistant text ${decant.assistantText}/${letta.assistantText}, reasoning ${decant.reasoning}/${letta.reasoning}`,
  });
  return lines;
}

function diagnosticsLine(sessionId: string, diagnostics: readonly Diagnostic[]): ParityLine | null {
  if (diagnostics.length === 0) {
    return null;
  }
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  const text = [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, n]) => `${code} x${n}`)
    .join(", ");
  return { level: "info", text: `${sessionId}: Letta diagnostics ${text}` };
}

function readDecantStructure(db: Database, sessionId: string): TranscriptStructure | null {
  const session = db
    .query(
      `SELECT id FROM session WHERE tool = 'opencode' AND source_session_id = ?1 ORDER BY id LIMIT 1`,
    )
    .get(sessionId) as { id: number } | null;
  if (session == null) {
    return null;
  }
  const structure: TranscriptStructure = {
    toolCalls: new Map(),
    user: 0,
    assistantText: 0,
    reasoning: 0,
  };
  const calls = db
    .query(
      `SELECT tool_use_id, tool_name, is_error, has_result FROM tool_call
        WHERE session_id = ?1 AND call_block_id IS NOT NULL AND tool_use_id IS NOT NULL
        ORDER BY ordinal`,
    )
    .all(session.id) as Array<{
    tool_use_id: string;
    tool_name: string | null;
    is_error: number | null;
    has_result: number | null;
  }>;
  for (const call of calls) {
    structure.toolCalls.set(call.tool_use_id, {
      name: call.tool_name ?? "",
      outcome: call.has_result === 1 ? (call.is_error === 1 ? "error" : "ok") : "none",
    });
  }
  const blocks = db
    .query(
      `SELECT m.role AS role, b.type AS type, COUNT(*) AS n
         FROM block b JOIN message m ON m.id = b.message_id
        WHERE b.session_id = ?1
        GROUP BY 1, 2`,
    )
    .all(session.id) as Array<{ role: string | null; type: string | null; n: number }>;
  for (const row of blocks) {
    if (row.role === "user" && row.type === "text") {
      structure.user += row.n;
    } else if (row.role === "assistant" && row.type === "text") {
      structure.assistantText += row.n;
    } else if (row.type === "thinking") {
      structure.reasoning += row.n;
    }
  }
  return structure;
}

/** The `--letta` pass over every session Decant reads from the 1.x tables. */
function lettaCrossCheck(opencode: Database, decant: Database): ParityLine[] {
  const lines: ParityLine[] = [];
  for (const session of readLegacySessions(opencode)) {
    const { messages, parts } = loadLegacyRows(opencode, session.id);
    const document = buildLegacyExport(session, messages, parts);
    const decantSide = readDecantStructure(decant, session.id);
    if (decantSide == null) {
      lines.push({
        level: document.messages.length > 0 ? "mismatch" : "info",
        text: `${session.id}: missing in Decant`,
      });
      continue;
    }
    let result: ReturnType<typeof normalizeTranscript>;
    try {
      result = normalizeTranscript({ source: "opencode", transcript: JSON.stringify(document) });
    } catch (error) {
      const code = error instanceof NormalizationError ? error.code : "error";
      lines.push({ level: "info", text: `${session.id}: Letta could not normalize it (${code})` });
      continue;
    }
    lines.push(...compareStructure(session.id, decantSide, lettaStructure(result.records)));
    const diagnostics = diagnosticsLine(session.id, result.diagnostics);
    if (diagnostics != null) {
      lines.push(diagnostics);
    }
  }
  return lines;
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
 * the message's raw record (`model.providerID` in 2.x, top-level `providerID`
 * in 1.x) and the model that served it. Reasoning is kept
 * only per session in the archive, so the per-model reasoning figure comes
 * from the reference side alone and Decant reports 0 here; the per-model
 * comparison therefore checks output (which contains reasoning), not the
 * reasoning field. */
function readDecantModelTotals(db: Database): ModelTotals[] {
  const groups = (
    db
      .query(
        `SELECT COALESCE(json_extract(${MESSAGE_METADATA_SQL}, '$.model.providerID'),
                         json_extract(${MESSAGE_METADATA_SQL}, '$.providerID')) AS provider,
                m.model AS model,
                COUNT(*) AS steps,
                COALESCE(SUM(m.input_tokens), 0) AS input,
                COALESCE(SUM(m.output_tokens), 0) AS output,
                COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read,
                COALESCE(SUM(m.cache_creation_tokens), 0) AS cache_write,
                COALESCE(SUM(CASE WHEN json_extract(${MESSAGE_METADATA_SQL}, '$.cost') > 0
                                  THEN json_extract(${MESSAGE_METADATA_SQL}, '$.cost') END), 0) AS recorded
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

const USAGE =
  "usage: bun run scripts/opencode-parity.ts <opencode.db> <decant.db> [stats.json] [--letta]";

function main(): void {
  const args = process.argv.slice(2);
  const letta = args.includes("--letta");
  const positional = args.filter((arg) => arg !== "--letta");
  const [opencodePath, decantPath, statsPath] = positional;
  if (
    opencodePath == null ||
    decantPath == null ||
    positional.length > 3 ||
    positional.some((arg) => arg.startsWith("--"))
  ) {
    console.error(USAGE);
    process.exit(2);
  }
  const opencode = openReadOnly(opencodePath);
  const decant = openReadOnly(decantPath);
  try {
    const decantModels = readDecantModelTotals(decant);
    const v2Rows = readOpenCodeAssistantRows(opencode);
    const legacyModels = readLegacyModelTotals(opencode);
    const reference = mergeModelTotals(openCodeModelTotals(v2Rows, "decant"), legacyModels);
    let mismatches = 0;
    console.log(`== per provider/model: Decant vs ${opencodePath} (2.x and 1.x rows)`);
    mismatches += print(
      compareModelTotals(decantModels, withReasoningInOutput(reference), "opencode.db"),
    );
    console.log("== Decant cost vs recorded cost");
    mismatches += print(compareRecordedCost(decantModels, reference));
    const compaction = readOpenCodeCompaction(opencode);
    console.log(
      `info     2.x compaction rows ${compaction.rows}: input ${compaction.input}, output ${compaction.output} (counted by Decant, not by opencode stats)`,
    );
    const legacyCompaction = readLegacyCompaction(opencode);
    console.log(
      `info     1.x compaction summaries ${legacyCompaction.rows}: input ${legacyCompaction.input}, output ${legacyCompaction.output} (counted by Decant)`,
    );
    const differences = openCodeRuleDifferences(v2Rows);
    const legacySteps = legacyModels.reduce((sum, row) => sum + row.steps, 0);
    console.log(
      `info     Decant differs from opencode stats by design: ${differences.inheritedWithoutForkLink} inherited 2.x row(s) of forks without a fork link (skipped), ${differences.reasoningIncluded} 2.x row(s) whose output already includes reasoning (not added again), ${differences.stepSums} migrated 2.x row(s) read from their 1.x step-finish parts, ${differences.legacyPreferred} 2.x row(s) of sessions read from a newer 1.x copy, ${legacySteps} 1.x step(s)`,
    );
    const decantSessions = readDecantSessionTotals(decant);
    console.log("== per session: Decant assistant-only vs session_v2");
    mismatches += print(compareSessionTotals(decantSessions, readOpenCodeSessionTotals(opencode)));
    const legacySessions = readLegacySessionTotals(opencode);
    if (legacySessions.length > 0) {
      console.log("== per session: Decant vs 1.x session columns (informational)");
      mismatches += print(compareLegacySessionTotals(decantSessions, legacySessions));
    }
    if (statsPath != null) {
      // 1.x `opencode stats` has no JSON output, so stats.json covers 2.x
      // rows only. It is checked against the database read with its own
      // rules; the line above quantifies how Decant's rules differ.
      const stats = parseStatsJson(readFileSync(statsPath, "utf8"));
      console.log(
        `== per provider/model: ${statsPath} vs opencode.db read with opencode stats' rules`,
      );
      mismatches += print(
        compareModelTotals(
          withReasoningInOutput(stats),
          withReasoningInOutput(openCodeModelTotals(v2Rows, "stats")),
          "opencode.db",
          "stats.json",
        ),
      );
    }
    if (letta) {
      console.log("== 1.x sessions: Decant vs Letta Trajectory (structure only)");
      mismatches += print(lettaCrossCheck(opencode, decant));
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
