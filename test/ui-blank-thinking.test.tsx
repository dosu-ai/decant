import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderableMessages, TranscriptBlock } from "../src/ui/transcript.tsx";
import type { SessionDetailData, TranscriptBlockData } from "../src/ui/types.ts";

const thinking = (text: string): TranscriptBlockData => ({
  ordinal: 0,
  block_type: "thinking",
  text,
  tool_name: null,
  tool_use_id: null,
  tool_input: null,
  tool_result: null,
});

// Hidden reasoning (Claude Code's signature-only thinking, OpenCode reasoning
// a provider withheld) is stored as an empty thinking block.
describe("blank thinking blocks", () => {
  test("render nothing", () => {
    expect(renderToStaticMarkup(<TranscriptBlock block={thinking("")} />)).toBe("");
    expect(renderToStaticMarkup(<TranscriptBlock block={thinking("  \n")} />)).toBe("");
    expect(renderToStaticMarkup(<TranscriptBlock block={thinking("Plan")} />)).toContain("Plan");
  });

  test("do not make a message renderable on their own", () => {
    const message = { blocks: [thinking("")], is_compact_boundary: false };
    const messages = [message] as unknown as SessionDetailData["messages"];
    expect(renderableMessages(messages)).toEqual([]);
  });
});
