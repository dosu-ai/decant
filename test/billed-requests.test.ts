import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultPricing, estimateCost } from "../src/cost.ts";
import { closeDb, openDb } from "../src/db.ts";
import { type IngestConfig, sync, upsertSession } from "../src/ingest.ts";
import type { TokenUsage } from "../src/model.ts";
import { setSessionUserState } from "../src/session-user-state.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-billed-requests-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function freshCase(): { db: Database; config: IngestConfig; dir: string } {
  caseCounter += 1;
  const dir = join(workDir, `case-${caseCounter}`);
  mkdirSync(dir, { recursive: true });
  return {
    db: openDb(join(dir, "archive.db")),
    config: { claudeDir: join(dir, "claude"), codexDir: join(dir, "codex") },
    dir,
  };
}

const MODEL = "claude-sonnet-5";
const ORIGINAL = "aaaaaaaa-0000-4000-8000-000000000001";
const BRANCH = "bbbbbbbb-0000-4000-8000-000000000002";
const SECOND_BRANCH = "cccccccc-0000-4000-8000-000000000003";

interface Turn {
  /** Suffix shared by the record uuids, `requestId`, and `message.id`. */
  id: string;
  prompt: string;
  at: string;
  input: number;
  output: number;
  thinking?: boolean;
}

const FIRST: Turn = {
  id: "1",
  prompt: "Summarize the README.",
  at: "2026-11-01T10:00:00.000Z",
  input: 1_000,
  output: 2_000,
};
const SECOND: Turn = {
  id: "2",
  prompt: "Now list the open questions.",
  at: "2026-11-01T10:05:00.000Z",
  input: 1_000,
  output: 500,
};
const THIRD: Turn = {
  id: "3",
  prompt: "Draft the changelog entry.",
  at: "2026-11-01T10:20:00.000Z",
  input: 3_000,
  output: 700,
};

/** One prompt and its reply, written the way Claude Code journals them. A copy
 * in a branched session differs only in `sessionId`, plus `forkedFrom` when
 * `/branch` made it. */
function turn(session: string, t: Turn, forkedFrom?: string): object[] {
  const marker = forkedFrom == null ? {} : { forkedFrom: { sessionId: forkedFrom } };
  return [
    {
      type: "user",
      uuid: `u${t.id}`,
      sessionId: session,
      timestamp: t.at,
      cwd: "/work/repro",
      message: { role: "user", content: t.prompt },
      ...(forkedFrom == null
        ? {}
        : { forkedFrom: { sessionId: forkedFrom, messageUuid: `u${t.id}` } }),
    },
    {
      type: "assistant",
      uuid: `a${t.id}`,
      parentUuid: `u${t.id}`,
      sessionId: session,
      timestamp: t.at.replace(":00.000Z", ":05.000Z"),
      requestId: `req_${t.id}`,
      message: {
        id: `msg_${t.id}`,
        role: "assistant",
        model: MODEL,
        stop_reason: "end_turn",
        usage: { input_tokens: t.input, output_tokens: t.output },
        content: [
          ...(t.thinking === true ? [{ type: "thinking", thinking: "Considering." }] : []),
          { type: "text", text: `Reply ${t.id}.` },
        ],
      },
      ...(forkedFrom == null
        ? {}
        : { forkedFrom: { ...marker.forkedFrom, messageUuid: `a${t.id}` } }),
    },
  ];
}

function jsonl(records: object[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/** `claude --resume <id> --fork-session`: new records first, stamped when the
 * fork was made, then the copied history with its original timestamps. */
function forkSessionTranscript(
  copied: Turn[],
  own: Turn[],
  session = BRANCH,
  forkedAt = "2026-11-01T10:04:00.000Z",
): string {
  return jsonl([
    { type: "mode", mode: "default", sessionId: session, timestamp: forkedAt },
    ...copied.flatMap((t) => turn(session, t)),
    ...own.flatMap((t) => turn(session, t)),
  ]);
}

/** `/branch`: the copied history comes first and every copied record names the
 * session it came from. */
function branchTranscript(copied: Turn[], own: Turn[], session = BRANCH, from = ORIGINAL): string {
  return jsonl([
    ...copied.flatMap((t) => turn(session, t, from)),
    ...own.flatMap((t) => turn(session, t)),
  ]);
}

function originalTranscript(turns: Turn[]): string {
  return jsonl(turns.flatMap((t) => turn(ORIGINAL, t)));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function sourcePath(config: IngestConfig, session: string): string {
  return join(config.claudeDir, "proj", `${session}.jsonl`);
}

function usage(...turns: Turn[]): TokenUsage {
  return {
    input: turns.reduce((sum, t) => sum + t.input, 0),
    output: turns.reduce((sum, t) => sum + t.output, 0),
    cacheRead: 0,
    cacheCreation: 0,
    cacheCreation1h: 0,
    reasoning: 0,
  };
}

function cost(...turns: Turn[]): number {
  return estimateCost(MODEL, usage(...turns), defaultPricing());
}

interface Stored {
  input: number;
  output: number;
  cost: number;
  messages: number;
  billed: number;
  model_input: number;
  model_output: number;
  requests: number;
}

function stored(db: Database, session: string): Stored {
  return db
    .query(
      `SELECT s.total_input_tokens AS input, s.total_output_tokens AS output,
              s.estimated_cost_usd AS cost, s.message_count AS messages,
              (SELECT COUNT(*) FROM message m
                WHERE m.session_id = s.id AND m.output_tokens IS NOT NULL) AS billed,
              (SELECT SUM(u.input_tokens) FROM session_model_usage u
                WHERE u.session_id = s.id) AS model_input,
              (SELECT SUM(u.output_tokens) FROM session_model_usage u
                WHERE u.session_id = s.id) AS model_output,
              (SELECT SUM(u.requests) FROM session_model_usage u
                WHERE u.session_id = s.id) AS requests
         FROM session s WHERE s.source_session_id = ?1`,
    )
    .get(session) as Stored;
}

function expectBilled(db: Database, session: string, messages: number, ...turns: Turn[]): void {
  const row = stored(db, session);
  const expected = usage(...turns);
  expect({ ...row, cost: undefined }).toEqual({
    input: expected.input,
    output: expected.output,
    cost: undefined,
    messages,
    billed: turns.length,
    model_input: expected.input,
    model_output: expected.output,
    requests: turns.length,
  });
  expect(row.cost).toBeCloseTo(cost(...turns), 12);
}

function archiveTotals(db: Database): { input: number; output: number; cost: number } {
  return db
    .query(
      `SELECT SUM(total_input_tokens) AS input, SUM(total_output_tokens) AS output,
              SUM(estimated_cost_usd) AS cost
         FROM session`,
    )
    .get() as { input: number; output: number; cost: number };
}

function ingest(db: Database, session: string, content: string): void {
  upsertSession(db, parseClaudeSession(session, content), `/x/${session}.jsonl`, 1, 2);
}

function estimate(db: Database, session: string): number {
  return (
    db
      .query("SELECT est_reasoning_tokens AS n FROM session WHERE source_session_id = ?1")
      .get(session) as { n: number }
  ).n;
}

/** What a user delete does: the session and its rows leave the archive. */
function remove(db: Database, session: string): void {
  const row = db.query("SELECT id FROM session WHERE source_session_id = ?1").get(session) as {
    id: number;
  };
  expect(setSessionUserState(db, row.id, "deleted")).toBe(true);
}

/** The branch as an archive that never held its original stores it. */
function branchAlone(session: string, content: string): Stored & { estimate: number } {
  const { db } = freshCase();
  ingest(db, session, content);
  const row = { ...stored(db, session), estimate: estimate(db, session) };
  closeDb(db);
  return row;
}

describe("requests copied into a branched Claude Code session", () => {
  test("a --fork-session copy is not billed again", () => {
    const { db, config } = freshCase();
    write(sourcePath(config, ORIGINAL), originalTranscript([FIRST]));
    sync(db, config);
    write(sourcePath(config, BRANCH), forkSessionTranscript([FIRST], [SECOND]));
    sync(db, config);

    expectBilled(db, ORIGINAL, 2, FIRST);
    // The copied turn stays in the branch's transcript without its usage.
    expectBilled(db, BRANCH, 4, SECOND);
    const totals = archiveTotals(db);
    expect(totals).toMatchObject({ input: 2_000, output: 2_500 });
    expect(totals.cost).toBeCloseTo(cost(FIRST, SECOND), 12);

    // An unchanged archive stays as it is.
    expect(sync(db, config).ingested).toBe(0);
    expectBilled(db, ORIGINAL, 2, FIRST);
    expectBilled(db, BRANCH, 4, SECOND);
    closeDb(db);
  });

  test("a /branch copy is not billed again", () => {
    const { db } = freshCase();
    ingest(db, ORIGINAL, originalTranscript([FIRST, SECOND]));
    ingest(db, BRANCH, branchTranscript([FIRST, SECOND], [THIRD]));

    expectBilled(db, ORIGINAL, 4, FIRST, SECOND);
    expectBilled(db, BRANCH, 6, THIRD);
    closeDb(db);
  });

  test("a turn whose original is not in the archive stays billed", () => {
    const { db } = freshCase();
    ingest(db, BRANCH, branchTranscript([FIRST], [SECOND]));

    expectBilled(db, BRANCH, 4, FIRST, SECOND);
    closeDb(db);
  });

  test("each turn counts once whichever transcript is read first", () => {
    const { db } = freshCase();
    ingest(db, BRANCH, forkSessionTranscript([FIRST], [SECOND]));
    ingest(db, ORIGINAL, originalTranscript([FIRST]));

    const totals = archiveTotals(db);
    expect(totals).toMatchObject({ input: 2_000, output: 2_500 });
    expect(totals.cost).toBeCloseTo(cost(FIRST, SECOND), 12);
    closeDb(db);
  });

  test("an original read after its --fork-session copy takes the turn back", () => {
    const { db } = freshCase();
    ingest(db, BRANCH, forkSessionTranscript([FIRST], [SECOND]));
    ingest(db, ORIGINAL, originalTranscript([FIRST]));

    expectBilled(db, ORIGINAL, 2, FIRST);
    expectBilled(db, BRANCH, 4, SECOND);
    closeDb(db);
  });

  test("an original read after its /branch copy takes the turn back", () => {
    const { db } = freshCase();
    ingest(db, BRANCH, branchTranscript([FIRST], [SECOND]));
    ingest(db, ORIGINAL, originalTranscript([FIRST]));

    expectBilled(db, ORIGINAL, 2, FIRST);
    expectBilled(db, BRANCH, 4, SECOND);
    closeDb(db);
  });

  // With the original gone, both sessions hold a copy. The same one has to
  // keep the turn whichever is read first.
  test("the earlier of two --fork-session copies keeps a turn in either order", () => {
    const sources: [string, string][] = [
      [BRANCH, forkSessionTranscript([FIRST], [SECOND])],
      [
        SECOND_BRANCH,
        forkSessionTranscript([FIRST], [THIRD], SECOND_BRANCH, "2026-11-01T10:10:00.000Z"),
      ],
    ];
    for (const order of [sources, [...sources].reverse()]) {
      const { db } = freshCase();
      for (const [session, content] of order) {
        ingest(db, session, content);
      }
      expectBilled(db, BRANCH, 4, FIRST, SECOND);
      expectBilled(db, SECOND_BRANCH, 4, THIRD);
      closeDb(db);
    }
  });

  test("a /branch copy keeps a turn over a branch made from it in either order", () => {
    const sources: [string, string][] = [
      [BRANCH, branchTranscript([FIRST], [SECOND])],
      [SECOND_BRANCH, branchTranscript([FIRST, SECOND], [THIRD], SECOND_BRANCH, BRANCH)],
    ];
    for (const order of [sources, [...sources].reverse()]) {
      const { db } = freshCase();
      for (const [session, content] of order) {
        ingest(db, session, content);
      }
      expectBilled(db, BRANCH, 4, FIRST, SECOND);
      expectBilled(db, SECOND_BRANCH, 6, THIRD);
      closeDb(db);
    }
  });

  test("the original keeps its turns when it grows after the branch", () => {
    const { db, config } = freshCase();
    const original = sourcePath(config, ORIGINAL);
    write(original, originalTranscript([FIRST]));
    sync(db, config);
    write(sourcePath(config, BRANCH), forkSessionTranscript([FIRST], [SECOND]));
    sync(db, config);

    appendFileSync(original, jsonl(turn(ORIGINAL, THIRD)));
    utimesSync(original, new Date(), new Date(Date.now() + 5_000));
    expect(sync(db, config).ingested).toBe(1);

    expectBilled(db, ORIGINAL, 4, FIRST, THIRD);
    expectBilled(db, BRANCH, 4, SECOND);
    closeDb(db);
  });

  test("a branch that grows stays free of the copied turns", () => {
    const { db, config } = freshCase();
    write(sourcePath(config, ORIGINAL), originalTranscript([FIRST]));
    const branch = sourcePath(config, BRANCH);
    write(branch, forkSessionTranscript([FIRST], [SECOND]));
    sync(db, config);

    appendFileSync(branch, jsonl(turn(BRANCH, THIRD)));
    utimesSync(branch, new Date(), new Date(Date.now() + 5_000));
    expect(sync(db, config).ingested).toBe(1);

    expectBilled(db, ORIGINAL, 2, FIRST);
    expectBilled(db, BRANCH, 6, SECOND, THIRD);
    closeDb(db);
  });

  test("sessions stored before the fix are corrected from their archived rows", () => {
    const { db, config, dir } = freshCase();
    write(sourcePath(config, ORIGINAL), originalTranscript([FIRST]));
    sync(db, config);
    write(sourcePath(config, BRANCH), forkSessionTranscript([FIRST], [SECOND]));
    sync(db, config);

    // Put the archive back the way an older release stored it: the copied turn
    // billed in both sessions, no owners recorded, usage split under the old
    // rule. The transcripts are gone, so only stored rows can correct it.
    db.exec(`
      DELETE FROM billed_request;
      DELETE FROM unbilled_request;
      UPDATE message
         SET input_tokens = json_extract(raw, '$.message.usage.input_tokens'),
             output_tokens = json_extract(raw, '$.message.usage.output_tokens')
       WHERE role = 'assistant';
      UPDATE session
         SET total_input_tokens = 2000, total_output_tokens = 2500
       WHERE source_session_id = '${BRANCH}';
      UPDATE session_model_usage SET format_version = 2;
    `);
    rmSync(join(dir, "claude"), { recursive: true });

    expect(sync(db, config).ingested).toBe(0);
    expectBilled(db, ORIGINAL, 2, FIRST);
    expectBilled(db, BRANCH, 4, SECOND);
    expect(sync(db, config).repriced).toBeUndefined();

    // The correction kept what it took off the copy, so the copy can bill it again.
    remove(db, ORIGINAL);
    expectBilled(db, BRANCH, 4, FIRST, SECOND);
    closeDb(db);
  });

  test("a result record that covers the copied history loses it too", () => {
    const { db } = freshCase();
    ingest(db, ORIGINAL, originalTranscript([FIRST]));
    ingest(
      db,
      BRANCH,
      forkSessionTranscript([FIRST], [SECOND]) +
        jsonl([{ type: "result", usage: { input_tokens: 2_000, output_tokens: 2_500 } }]),
    );

    expectBilled(db, BRANCH, 4, SECOND);
    closeDb(db);
  });

  test("a result record for the new run alone is kept as recorded", () => {
    const { db } = freshCase();
    ingest(db, ORIGINAL, originalTranscript([FIRST]));
    ingest(
      db,
      BRANCH,
      forkSessionTranscript([FIRST], [SECOND]) +
        jsonl([{ type: "result", usage: { input_tokens: 1_000, output_tokens: 500 } }]),
    );

    expectBilled(db, BRANCH, 4, SECOND);
    closeDb(db);
  });

  test("the reasoning estimate shrinks with the output that left", () => {
    const { db } = freshCase();
    const thinking: Turn = { ...FIRST, thinking: true };
    ingest(db, ORIGINAL, originalTranscript([thinking]));
    ingest(db, BRANCH, forkSessionTranscript([thinking], [{ ...SECOND, thinking: true }]));

    // Both turns show a few characters of text, so nearly all output is
    // inferred reasoning: about 2,000 tokens in the original, 500 in the branch.
    expect(estimate(db, ORIGINAL)).toBeGreaterThan(1_900);
    expect(estimate(db, BRANCH)).toBeGreaterThan(400);
    expect(estimate(db, BRANCH)).toBeLessThanOrEqual(500);
    closeDb(db);
  });

  // Each reply shows "Reply N." (8 characters, 2 tokens), so the rest of its
  // output is inferred reasoning when the turn shows thinking.
  test("a copied turn's thinking leaves the branch with it", () => {
    const { db } = freshCase();
    const thinking: Turn = { ...FIRST, thinking: true };
    ingest(db, ORIGINAL, originalTranscript([thinking]));
    ingest(db, BRANCH, forkSessionTranscript([thinking], [SECOND]));

    expect(estimate(db, ORIGINAL)).toBe(FIRST.output - 2);
    expect(estimate(db, BRANCH)).toBe(0);
    closeDb(db);
  });

  test("a branch's own thinking stays when the copied turn had none", () => {
    const { db } = freshCase();
    ingest(db, ORIGINAL, originalTranscript([FIRST]));
    ingest(db, BRANCH, forkSessionTranscript([FIRST], [{ ...SECOND, thinking: true }]));

    expect(estimate(db, ORIGINAL)).toBe(0);
    expect(estimate(db, BRANCH)).toBe(SECOND.output - 2);
    closeDb(db);
  });

  test("two /branch copies of a missing original keep a turn in the same one in either order", () => {
    // Both start at the copied turn's timestamp and neither names the other.
    const sources: [string, string][] = [
      [SECOND_BRANCH, branchTranscript([FIRST], [THIRD], SECOND_BRANCH, ORIGINAL)],
      [BRANCH, branchTranscript([FIRST], [SECOND], BRANCH, ORIGINAL)],
    ];
    for (const order of [sources, [...sources].reverse()]) {
      const { db } = freshCase();
      for (const [session, content] of order) {
        ingest(db, session, content);
      }
      expectBilled(db, BRANCH, 4, FIRST, SECOND);
      expectBilled(db, SECOND_BRANCH, 4, THIRD);
      closeDb(db);
    }
  });

  test("deleting the original bills the copy again while its source is still there", () => {
    const { db, config } = freshCase();
    write(sourcePath(config, ORIGINAL), originalTranscript([FIRST]));
    write(sourcePath(config, BRANCH), forkSessionTranscript([FIRST], [SECOND]));
    sync(db, config);
    expectBilled(db, BRANCH, 4, SECOND);

    remove(db, ORIGINAL);
    expectBilled(db, BRANCH, 4, FIRST, SECOND);
    // The branch is unchanged, so nothing re-reads it, and the delete holds.
    expect(sync(db, config).ingested).toBe(0);
    expectBilled(db, BRANCH, 4, FIRST, SECOND);
    expect(db.query("SELECT COUNT(*) AS n FROM unbilled_request").get()).toEqual({ n: 0 });
    closeDb(db);
  });

  // With the sources gone only stored rows can put the usage back, and the
  // branch has to match an archive that never held its original.
  const branches: [string, string][] = [
    ["--fork-session", forkSessionTranscript([FIRST], [{ ...SECOND, thinking: true }])],
    ["/branch", branchTranscript([{ ...FIRST, thinking: true }], [SECOND])],
    [
      "--fork-session with a result record for the whole transcript",
      forkSessionTranscript([FIRST], [SECOND]) +
        jsonl([{ type: "result", usage: { input_tokens: 2_000, output_tokens: 2_500 } }]),
    ],
    [
      "--fork-session with a result record for the new run alone",
      forkSessionTranscript([FIRST], [SECOND]) +
        jsonl([{ type: "result", usage: { input_tokens: 1_000, output_tokens: 500 } }]),
    ],
  ];
  for (const [kind, content] of branches) {
    test(`deleting the original restores a ${kind} copy from stored rows in either order`, () => {
      const alone = branchAlone(BRANCH, content);
      const sources: [string, string][] = [
        [ORIGINAL, originalTranscript([{ ...FIRST, thinking: true }])],
        [BRANCH, content],
      ];
      for (const order of [sources, [...sources].reverse()]) {
        const { db } = freshCase();
        for (const [session, transcript] of order) {
          ingest(db, session, transcript);
        }
        expect(stored(db, BRANCH).billed).toBe(1);

        remove(db, ORIGINAL);
        expect({ ...stored(db, BRANCH), estimate: estimate(db, BRANCH) }).toEqual(alone);
        const totals = archiveTotals(db);
        expect(totals).toMatchObject({ input: alone.input, output: alone.output });
        expect(totals.cost).toBeCloseTo(alone.cost, 12);
        closeDb(db);
      }
    });
  }

  test("a result record for the new run alone is not inflated when the copy is restored", () => {
    const { db } = freshCase();
    ingest(db, ORIGINAL, originalTranscript([FIRST]));
    ingest(
      db,
      BRANCH,
      forkSessionTranscript([FIRST], [SECOND]) +
        jsonl([{ type: "result", usage: { input_tokens: 1_000, output_tokens: 500 } }]),
    );

    remove(db, ORIGINAL);
    const row = stored(db, BRANCH);
    expect(row).toMatchObject({ input: 1_000, output: 500, billed: 2, requests: 2 });
    expect(row).toMatchObject({ model_input: 1_000, model_output: 500 });
    closeDb(db);
  });

  test("deleting the original hands a turn to the copy the others were made from", () => {
    const sources: [string, string][] = [
      [ORIGINAL, originalTranscript([FIRST])],
      [SECOND_BRANCH, branchTranscript([FIRST, SECOND], [THIRD], SECOND_BRANCH, BRANCH)],
      [BRANCH, branchTranscript([FIRST], [SECOND])],
    ];
    for (const order of [sources, [...sources].reverse()]) {
      const { db } = freshCase();
      for (const [session, content] of order) {
        ingest(db, session, content);
      }
      remove(db, ORIGINAL);
      expectBilled(db, BRANCH, 4, FIRST, SECOND);
      expectBilled(db, SECOND_BRANCH, 6, THIRD);
      closeDb(db);
    }
  });

  test("deleting a copy leaves the original's billing alone", () => {
    const { db } = freshCase();
    ingest(db, ORIGINAL, originalTranscript([FIRST]));
    ingest(db, BRANCH, forkSessionTranscript([FIRST], [SECOND]));

    remove(db, BRANCH);
    expectBilled(db, ORIGINAL, 2, FIRST);
    expect(db.query("SELECT COUNT(*) AS n FROM unbilled_request").get()).toEqual({ n: 0 });
    closeDb(db);
  });

  test("deleting the session that bills a turn clears its claim", () => {
    const { db } = freshCase();
    ingest(db, ORIGINAL, originalTranscript([FIRST]));
    expect(db.query("SELECT COUNT(*) AS n FROM billed_request").get()).toEqual({ n: 1 });
    db.query("DELETE FROM session WHERE source_session_id = ?1").run(ORIGINAL);
    expect(db.query("SELECT COUNT(*) AS n FROM billed_request").get()).toEqual({ n: 0 });
    closeDb(db);
  });
});
