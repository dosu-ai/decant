import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPricing, estimateCost } from "../src/cost.ts";
import { closeDb, openDb } from "../src/db.ts";
import { upsertSession } from "../src/ingest.ts";
import type { TokenUsage } from "../src/model.ts";
import {
  deriveModelUsage,
  materializeMissingModelUsage,
  materializeModelUsage,
} from "../src/model-usage.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";
import { byDimension, totals } from "../src/stats.ts";
import { refreshSessionCosts, tokenEconomicsForSession } from "../src/token-economics.ts";
import { syntheticOpenCodeSession } from "./opencode-session.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-model-usage-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;
function freshDb(): Database {
  counter += 1;
  return openDb(join(workDir, `usage-${counter}.db`));
}

interface Request {
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  cacheCreation1h?: number;
  speed?: string;
}

/** A hand-written Claude Code journal: one prompt, then one assistant record
 * per request, each with its own API message id. */
function transcript(requests: Request[]): string {
  const lines: object[] = [
    {
      type: "user",
      uuid: "u0",
      parentUuid: null,
      sessionId: "sess-usage",
      timestamp: "2026-10-07T10:00:00.000Z",
      cwd: "/work/usage",
      message: { role: "user", content: "Price each request by its own model" },
    },
  ];
  for (const [index, request] of requests.entries()) {
    const usage: Record<string, unknown> = {
      input_tokens: request.input,
      output_tokens: request.output,
      cache_read_input_tokens: request.cacheRead ?? 0,
      cache_creation_input_tokens: request.cacheCreation ?? 0,
    };
    if (request.cacheCreation1h != null) {
      usage.cache_creation = {
        ephemeral_5m_input_tokens: (request.cacheCreation ?? 0) - request.cacheCreation1h,
        ephemeral_1h_input_tokens: request.cacheCreation1h,
      };
    }
    if (request.speed != null) {
      usage.speed = request.speed;
    }
    lines.push({
      type: "assistant",
      uuid: `a${index}`,
      parentUuid: index === 0 ? "u0" : `a${index - 1}`,
      sessionId: "sess-usage",
      requestId: `req_${index}`,
      timestamp: `2026-10-07T10:00:${String(index + 1).padStart(2, "0")}.000Z`,
      message: {
        id: `msg_${index}`,
        role: "assistant",
        model: request.model,
        stop_reason: "end_turn",
        usage,
        content: [{ type: "text", text: `Reply ${index}` }],
      },
    });
  }
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

function ingest(db: Database, requests: Request[], id = "sess-usage"): number {
  return upsertSession(db, parseClaudeSession(id, transcript(requests)), `/x/${id}.jsonl`, 1, 2);
}

function usageOf(request: Request): TokenUsage {
  return {
    input: request.input,
    output: request.output,
    cacheRead: request.cacheRead ?? 0,
    cacheCreation: request.cacheCreation ?? 0,
    cacheCreation1h: request.cacheCreation1h ?? 0,
    reasoning: 0,
  };
}

function storedRows(db: Database, sessionId: number) {
  return db
    .query(
      `SELECT model, tier, requests, input_tokens, output_tokens, cache_read_tokens,
              cache_creation_tokens, cache_creation_1h_tokens, reported_cost_usd
         FROM session_model_usage WHERE session_id = ?1 ORDER BY model, tier`,
    )
    .all(sessionId);
}

function storedCost(db: Database, sessionId: number): number {
  return (
    db.query("SELECT estimated_cost_usd FROM session WHERE id = ?1").get(sessionId) as {
      estimated_cost_usd: number;
    }
  ).estimated_cost_usd;
}

const OPUS_55_A: Request = {
  model: "claude-opus-5-5",
  input: 1_000,
  output: 200,
  cacheRead: 10_000,
  cacheCreation: 2_000,
  cacheCreation1h: 500,
};
const OPUS_5: Request = { model: "claude-opus-5", input: 2_000, output: 400, cacheRead: 5_000 };
const OPUS_55_B: Request = { model: "claude-opus-5-5", input: 300, output: 100, cacheRead: 12_000 };

describe("per-model usage", () => {
  test("prices each request at the model that served it", () => {
    const db = freshDb();
    const id = ingest(db, [OPUS_55_A, OPUS_5, OPUS_55_B]);
    const pricing = defaultPricing();

    expect(db.query("SELECT model FROM session WHERE id = ?1").get(id)).toEqual({
      model: "claude-opus-5-5",
    });
    expect(storedRows(db, id)).toEqual([
      {
        model: "claude-opus-5",
        tier: "standard",
        requests: 1,
        input_tokens: 2_000,
        output_tokens: 400,
        cache_read_tokens: 5_000,
        cache_creation_tokens: 0,
        cache_creation_1h_tokens: 0,
        reported_cost_usd: null,
      },
      {
        model: "claude-opus-5-5",
        tier: "standard",
        requests: 2,
        input_tokens: 1_300,
        output_tokens: 300,
        cache_read_tokens: 22_000,
        cache_creation_tokens: 2_000,
        cache_creation_1h_tokens: 500,
        reported_cost_usd: null,
      },
    ]);

    const expected =
      estimateCost("claude-opus-5-5", usageOf(OPUS_55_A), pricing) +
      estimateCost("claude-opus-5-5", usageOf(OPUS_55_B), pricing) +
      estimateCost("claude-opus-5", usageOf(OPUS_5), pricing);
    expect(storedCost(db, id)).toBeCloseTo(expected, 12);
    // The single-label estimate this replaces billed Opus 5 tokens at Opus 5.5 rates.
    const singleLabel = estimateCost(
      "claude-opus-5-5",
      {
        input: 3_300,
        output: 700,
        cacheRead: 27_000,
        cacheCreation: 2_000,
        cacheCreation1h: 500,
        reasoning: 0,
      },
      pricing,
    );
    expect(storedCost(db, id)).toBeGreaterThan(singleLabel);
    expect(tokenEconomicsForSession(db, id)?.totals.estimated_cost_usd).toBeCloseTo(expected, 12);
    closeDb(db);
  });

  test("bills fast-mode requests at the fast tier", () => {
    const db = freshDb();
    const fast: Request = { model: "claude-opus-5-5", input: 1_000, output: 1_000, speed: "fast" };
    const standard: Request = { ...fast, speed: "standard" };
    const id = ingest(db, [fast, standard]);
    expect(storedRows(db, id)).toEqual([
      expect.objectContaining({ model: "claude-opus-5-5", tier: "fast", requests: 1 }),
      expect.objectContaining({ model: "claude-opus-5-5", tier: "standard", requests: 1 }),
    ]);
    const base = estimateCost("claude-opus-5-5", usageOf(standard), defaultPricing());
    expect(storedCost(db, id)).toBeCloseTo(base * 3, 12);
    closeDb(db);
  });

  test("bills Haiku 5.5 requests past 100,000 prompt tokens at the long-prompt tier", () => {
    const db = freshDb();
    const long: Request = {
      model: "claude-haiku-5-5",
      input: 50_000,
      output: 1_000,
      cacheRead: 60_000,
    };
    const short: Request = {
      model: "claude-haiku-5-5",
      input: 50_000,
      output: 1_000,
      cacheRead: 50_000,
    };
    const id = ingest(db, [long, short]);
    expect(storedRows(db, id)).toEqual([
      expect.objectContaining({ tier: "long_prompt", requests: 1, cache_read_tokens: 60_000 }),
      expect.objectContaining({ tier: "standard", requests: 1, cache_read_tokens: 50_000 }),
    ]);
    const pricing = defaultPricing();
    expect(storedCost(db, id)).toBeCloseTo(
      estimateCost("claude-haiku-5-5", usageOf(long), pricing, "long_prompt") +
        estimateCost("claude-haiku-5-5", usageOf(short), pricing),
      12,
    );
    expect(estimateCost("claude-haiku-5-5", usageOf(long), pricing, "long_prompt")).toBeCloseTo(
      5 * estimateCost("claude-haiku-5-5", usageOf(long), pricing),
      12,
    );
    closeDb(db);
  });

  test("charges locally generated records to the session's model", () => {
    const db = freshDb();
    const synthetic: Request = { model: "<synthetic>", input: 0, output: 0 };
    const id = ingest(db, [OPUS_55_B, synthetic]);
    expect(storedRows(db, id)).toEqual([
      expect.objectContaining({ model: "claude-opus-5-5", tier: "standard", requests: 2 }),
    ]);
    closeDb(db);
  });

  test("keeps one row of session totals for sources without per-request models", () => {
    const db = freshDb();
    const source = readFileSync(
      join(import.meta.dir, "..", "fixtures", "codex", "sample.jsonl"),
      "utf8",
    );
    const id = upsertSession(
      db,
      parseCodexSession("codex-usage", source, new Map()),
      "/x/codex.jsonl",
      1,
      2,
    );
    const session = db
      .query(
        `SELECT model, total_input_tokens AS input_tokens, total_output_tokens AS output_tokens,
                total_cache_read_tokens AS cache_read_tokens
           FROM session WHERE id = ?1`,
      )
      .get(id) as Record<string, unknown>;
    expect(storedRows(db, id)).toEqual([expect.objectContaining({ ...session, tier: "standard" })]);
    closeDb(db);
  });

  test("falls back to session totals when requests cannot account for them", () => {
    const db = freshDb();
    const id = ingest(db, [OPUS_55_A, OPUS_5, OPUS_55_B]);
    db.query("UPDATE session SET total_output_tokens = 1 WHERE id = ?1").run(id);
    expect(deriveModelUsage(db, id)).toEqual([
      expect.objectContaining({ model: "claude-opus-5-5", tier: "standard", requests: 3 }),
    ]);
    expect(deriveModelUsage(db, id)?.[0]?.usage.output).toBe(1);
    expect(deriveModelUsage(db, 999_999)).toBeNull();
    closeDb(db);
  });

  test("sync backfills rows for sessions stored before the split and reprices them", () => {
    const db = freshDb();
    const id = ingest(db, [OPUS_55_A, OPUS_5, OPUS_55_B]);
    const correct = storedCost(db, id);
    const economics = tokenEconomicsForSession(db, id)?.totals.estimated_cost_usd;
    // Simulate an archive written by a build that priced the session label.
    db.exec("DELETE FROM session_model_usage");
    db.query("UPDATE session SET estimated_cost_usd = 1 WHERE id = ?1").run(id);
    db.query(
      `UPDATE session_economics
          SET vector_json = json_set(vector_json, '$.input_cost', 0.5, '$.output_cost', 0.5)
        WHERE session_id = ?1`,
    ).run(id);

    expect(materializeMissingModelUsage(db)).toBe(1);
    expect(materializeMissingModelUsage(db)).toBe(0);
    expect(refreshSessionCosts(db)).toBe(1);
    expect(refreshSessionCosts(db)).toBe(0);
    expect(storedCost(db, id)).toBe(correct);
    expect(tokenEconomicsForSession(db, id)?.totals.estimated_cost_usd).toBe(economics ?? -1);
    expect(storedRows(db, id)).toHaveLength(2);

    // Rows from an older split rule are rebuilt once.
    db.exec("UPDATE session_model_usage SET format_version = 0");
    expect(materializeMissingModelUsage(db)).toBe(1);
    expect(materializeMissingModelUsage(db)).toBe(0);
    closeDb(db);
  });

  test("materializing again replaces the session's rows", () => {
    const db = freshDb();
    const id = ingest(db, [OPUS_55_A, OPUS_5]);
    db.transaction(() => materializeModelUsage(db, id))();
    expect(storedRows(db, id)).toHaveLength(2);
    db.query("DELETE FROM session WHERE id = ?1").run(id);
    expect(db.query("SELECT COUNT(*) AS n FROM session_model_usage").get()).toEqual({ n: 0 });
    closeDb(db);
  });

  test("the model breakdown follows each request while sessions keep one label", () => {
    const db = freshDb();
    const mixed = ingest(db, [OPUS_55_A, OPUS_5, OPUS_55_B], "sess-mixed");
    ingest(db, [OPUS_5], "sess-opus-5");
    const rows = byDimension(db, "model");
    const pricing = defaultPricing();
    const opus5 = rows.find((row) => row.key === "claude-opus-5");
    const opus55 = rows.find((row) => row.key === "claude-opus-5-5");
    expect(opus55).toMatchObject({ sessions: 1, input_tokens: 1_300, output_tokens: 300 });
    expect(opus5).toMatchObject({ sessions: 1, input_tokens: 4_000, output_tokens: 800 });
    expect(opus5?.estimated_cost_usd).toBeCloseTo(
      2 * estimateCost("claude-opus-5", usageOf(OPUS_5), pricing),
      12,
    );
    const sum = rows.reduce((total, row) => total + row.estimated_cost_usd, 0);
    expect(sum).toBeCloseTo(totals(db).estimated_cost_usd, 12);
    expect(storedCost(db, mixed)).toBeCloseTo(
      (opus55?.estimated_cost_usd ?? 0) + estimateCost("claude-opus-5", usageOf(OPUS_5), pricing),
      12,
    );
    closeDb(db);
  });
});

describe("reported cost fallback", () => {
  function ingestOpenCode(
    db: Database,
    id: string,
    requests: Parameters<typeof syntheticOpenCodeSession>[1],
  ): number {
    return upsertSession(
      db,
      syntheticOpenCodeSession(id, requests),
      `/tmp/opencode.db#${id}`,
      1,
      0,
      id,
    );
  }

  test("uses OpenCode's recorded cost only for a model Decant cannot price", () => {
    const db = freshDb();
    const id = ingestOpenCode(db, "ses_unpriced", [
      { model: "example-unpriced", cost: 0.25, input: 100, output: 10 },
      { model: "example-unpriced", cost: 0.5, input: 200, output: 20 },
    ]);
    expect(storedRows(db, id)).toEqual([
      {
        model: "example-unpriced",
        tier: "standard",
        requests: 2,
        input_tokens: 300,
        output_tokens: 30,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cache_creation_1h_tokens: 0,
        reported_cost_usd: 0.75,
      },
    ]);
    expect(storedCost(db, id)).toBeCloseTo(0.75, 12);
    const economics = tokenEconomicsForSession(db, id);
    expect(economics?.totals).toMatchObject({
      estimated_cost_usd: 0.75,
      input_cost_usd: 0,
      output_cost_usd: 0,
      reported_cost_usd: 0.75,
    });
    expect(
      economics?.buckets.reduce((sum, bucket) => sum + bucket.estimated_cost_usd, 0),
    ).toBeCloseTo(0.75, 12);
    // The fallback is part of what a repricing sync recomputes, so nothing is
    // pending and the total cannot flap between syncs.
    expect(refreshSessionCosts(db)).toBe(0);
    closeDb(db);
  });

  test("ignores a recorded cost of zero", () => {
    const db = freshDb();
    const id = ingestOpenCode(db, "ses_zero", [
      { model: "example-unpriced", cost: 0, input: 100, output: 10 },
    ]);
    expect(storedRows(db, id)).toMatchObject([{ reported_cost_usd: null }]);
    expect(storedCost(db, id)).toBe(0);
    expect(tokenEconomicsForSession(db, id)?.totals.reported_cost_usd).toBe(0);
    closeDb(db);
  });

  test("keeps Decant's list price when the model is priceable", () => {
    const db = freshDb();
    const id = ingestOpenCode(db, "ses_priced", [
      { model: "glm-5.3-flash", cost: 99, input: 1_000_000, output: 1_000_000 },
    ]);
    expect(storedRows(db, id)).toMatchObject([{ model: "glm-5.3-flash", reported_cost_usd: null }]);
    expect(storedCost(db, id)).toBeCloseTo(0.65, 9);
    expect(refreshSessionCosts(db)).toBe(0);
    closeDb(db);
  });

  test("keeps reported and priced rows apart in a mixed session", () => {
    const db = freshDb();
    const id = ingestOpenCode(db, "ses_mixed", [
      { model: "glm-5.3-flash", cost: 0.1, input: 1_000_000, output: 0 },
      { model: "example-unpriced", cost: 0.3, input: 100, output: 10 },
    ]);
    expect(storedRows(db, id)).toMatchObject([
      { model: "example-unpriced", requests: 1, reported_cost_usd: 0.3 },
      { model: "glm-5.3-flash", requests: 1, reported_cost_usd: null },
    ]);
    expect(storedCost(db, id)).toBeCloseTo(0.15 + 0.3, 9);
    const totals = tokenEconomicsForSession(db, id)?.totals;
    expect(totals?.input_cost_usd).toBeCloseTo(0.15, 9);
    expect(totals?.reported_cost_usd).toBe(0.3);
    expect(totals?.estimated_cost_usd).toBeCloseTo(0.45, 9);
    closeDb(db);
  });

  test("stops using a stored reported cost once the model has a rate", () => {
    const db = freshDb();
    const id = ingestOpenCode(db, "ses_rated_later", [
      { model: "glm-5.3-flash", cost: 99, input: 1_000_000, output: 1_000_000 },
    ]);
    // Simulate a row derived before Decant had a rate for the model.
    db.query("UPDATE session_model_usage SET reported_cost_usd = 5 WHERE session_id = ?1").run(id);
    db.query("UPDATE session SET estimated_cost_usd = 0 WHERE id = ?1").run(id);
    expect(refreshSessionCosts(db)).toBe(1);
    expect(storedCost(db, id)).toBeCloseTo(0.65, 9);
    expect(tokenEconomicsForSession(db, id)?.totals.reported_cost_usd).toBe(0);
    expect(refreshSessionCosts(db)).toBe(0);
    closeDb(db);
  });

  test("sums recorded cost only for unpriced models when usage overshoots the totals", () => {
    const db = freshDb();
    const parsed = syntheticOpenCodeSession("ses_residual", [
      { model: "example-unpriced", cost: 0.3, input: 100, output: 10 },
      { model: "glm-5.3-flash", cost: 99, input: 200, output: 20 },
    ]);
    // Session totals below the per-request sum make the residual negative, so
    // the session-level split is used.
    parsed.session.totals.input = 1;
    parsed.session.totals.output = 1;
    const id = upsertSession(db, parsed, "/tmp/opencode.db#ses_residual", 1, 0, "ses_residual");
    expect(storedRows(db, id)).toMatchObject([
      { model: "example-unpriced", reported_cost_usd: 0.3 },
    ]);
    expect(storedCost(db, id)).toBeCloseTo(0.3, 12);
    expect(refreshSessionCosts(db)).toBe(0);
    closeDb(db);
  });
});
