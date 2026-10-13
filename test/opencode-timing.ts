import type { Json } from "../src/model.ts";
import type { OpenCodeMessageRow, OpenCodeSessionRow } from "../src/sources/opencode.ts";

const T0 = 1791786000000; // 2026-10-12T06:20:00.000Z

/** Epoch milliseconds for the synthetic two-turn session below. The step
 * shapes follow OpenCode 2.0.27: parts open when the stream starts and close
 * when it ends, a text part has no time, and `time.streamed` marks the end of
 * the provider response, before tool settlement. */
export const STEP_TIMES = {
  session: T0,
  prompt1: T0 + 100,
  step1Created: T0 + 200,
  reasoning1Created: T0 + 1_700,
  reasoning1Completed: T0 + 1_900,
  toolCreated: T0 + 1_750,
  toolRan: T0 + 2_000,
  toolCompleted: T0 + 2_150,
  step1Streamed: T0 + 2_100,
  step1Completed: T0 + 2_200,
  prompt2: T0 + 180_000,
  step2Created: T0 + 180_100,
  reasoning2Created: T0 + 180_150,
  reasoning2Completed: T0 + 181_000,
  step2Streamed: T0 + 181_050,
  step2Completed: T0 + 181_100,
} as const;

const T = STEP_TIMES;
const MODEL = { providerID: "example-provider", id: "glm-5.3-flash", variant: "high" };

export function timingSessionRow(): OpenCodeSessionRow {
  return {
    id: "ses_timing",
    project_id: "prj_timing",
    parent_id: null,
    fork_session_id: null,
    fork_boundary: null,
    slug: "timing",
    directory: "/decant-fixture/example",
    title: "Timing example",
    version: "2.0.27",
    cost: 0,
    tokens_input: 2200,
    tokens_output: 110,
    tokens_reasoning: 390,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    agent: "build",
    model: JSON.stringify(MODEL),
    time_created: T.session,
    time_updated: T.step2Completed,
    time_archived: null,
  };
}

function row(seq: number, type: string, created: number, data: Json): OpenCodeMessageRow {
  return {
    id: `msg_timing_${seq}`,
    session_id: "ses_timing",
    type,
    seq,
    time_created: created,
    time_updated: created,
    data: JSON.stringify(data),
  };
}

/** Prompt, a step that reasons then reads a file, a second prompt, and a
 * step that reasons (hidden: empty text) then answers. Step 1 reports 150 of
 * its 200 output tokens as reasoning; step 2 reports 240 of 300. */
export function timingMessageRows(): OpenCodeMessageRow[] {
  return [
    row(1, "user", T.prompt1, { text: "Read the notes.", files: [], time: { created: T.prompt1 } }),
    row(2, "assistant", T.step1Created, {
      agent: "build",
      model: MODEL,
      content: [
        {
          type: "reasoning",
          text: "Read the file first.",
          time: { created: T.reasoning1Created, completed: T.reasoning1Completed },
        },
        {
          type: "tool",
          id: "call_timing_read",
          name: "read",
          state: {
            status: "completed",
            input: { path: "/decant-fixture/example/notes.txt" },
            content: [{ type: "text", text: "hello" }],
          },
          time: { created: T.toolCreated, ran: T.toolRan, completed: T.toolCompleted },
        },
      ],
      finish: "tool-calls",
      cost: 0,
      tokens: { input: 1000, output: 50, reasoning: 150, cache: { read: 0, write: 0 } },
      time: { created: T.step1Created, streamed: T.step1Streamed, completed: T.step1Completed },
    }),
    row(3, "user", T.prompt2, { text: "And then?", files: [], time: { created: T.prompt2 } }),
    row(4, "assistant", T.step2Created, {
      agent: "build",
      model: MODEL,
      content: [
        {
          type: "reasoning",
          text: "",
          time: { created: T.reasoning2Created, completed: T.reasoning2Completed },
        },
        { type: "text", text: "The notes say hello.", time: null },
      ],
      finish: "stop",
      cost: 0,
      tokens: { input: 1200, output: 60, reasoning: 240, cache: { read: 0, write: 0 } },
      time: { created: T.step2Created, streamed: T.step2Streamed, completed: T.step2Completed },
    }),
  ];
}
