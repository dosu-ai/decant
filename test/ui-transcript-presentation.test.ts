import { describe, expect, test } from "bun:test";
import {
  parseTranscriptDialogue,
  structuredTranscriptBlock,
} from "../src/ui/transcript-presentation.ts";

describe("structured transcript presentation", () => {
  test("turns realtime lifecycle metadata into a compact event", () => {
    expect(
      structuredTranscriptBlock(`<realtime_conversation>
Realtime conversation ended.

Reason: inactive
</realtime_conversation>`),
    ).toEqual({
      kind: "realtime-ended",
      title: "Realtime conversation ended",
      description:
        "Voice mode ended after a period of inactivity. The conversation continued in text.",
      chips: ["voice", "inactive"],
      dialogue: [],
    });
  });

  test("extracts a readable multi-speaker realtime handoff", () => {
    const block = structuredTranscriptBlock(`<realtime_delegation>
  <source>transcript_tail_flush</source>
  <input>Internal handoff instruction.</input>
  <transcript_delta>assistant: Got it.
user: Please add a Stream Deck button.
assistant: Bring the profile grid to the foreground.</transcript_delta>
</realtime_delegation>`);

    expect(block).toMatchObject({
      kind: "realtime-handoff",
      title: "Realtime handoff",
      chips: ["voice", "final exchange", "3 messages"],
      dialogue: [
        { speaker: "assistant", text: "Got it." },
        { speaker: "user", text: "Please add a Stream Deck button." },
        { speaker: "assistant", text: "Bring the profile grid to the foreground." },
      ],
    });
  });

  test("uses direct delegation input as a voice message", () => {
    expect(
      structuredTranscriptBlock(`<realtime_delegation>
  <input>How can I fix the audio utilities?</input>
</realtime_delegation>`),
    ).toMatchObject({
      kind: "realtime-handoff",
      title: "Voice input",
      dialogue: [{ speaker: "user", text: "How can I fix the audio utilities?" }],
    });
  });

  test("summarizes primary-agent instructions instead of exposing boilerplate", () => {
    expect(
      structuredTranscriptBlock(`You are \`/root\`, the primary agent in a team of agents collaborating to fulfill the user's goals.

All agents share the same directory.
There are 4 available concurrency slots.`),
    ).toEqual({
      kind: "collaboration",
      title: "Multi-agent collaboration",
      description:
        "This session uses a primary coordinator that can delegate work to agents sharing the same workspace.",
      chips: ["primary agent", "4 slots", "shared workspace"],
      dialogue: [],
    });
  });

  test("keeps ordinary conversation untouched", () => {
    expect(structuredTranscriptBlock("Please fix the pagination bug.")).toBeNull();
  });
});

describe("realtime dialogue parsing", () => {
  test("preserves wrapped content until the next speaker marker", () => {
    expect(
      parseTranscriptDialogue("user: first line\ncontinues here\nassistant: response"),
    ).toEqual([
      { speaker: "user", text: "first line\ncontinues here" },
      { speaker: "assistant", text: "response" },
    ]);
  });
});
