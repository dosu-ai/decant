import { describe, expect, test } from "bun:test";
import { toolCallStatus } from "../src/ui/tool-call-status.ts";

describe("tool call status", () => {
  test("distinguishes confirmed success and error with icon and tone metadata", () => {
    expect(toolCallStatus(false, true)).toEqual({
      icon: "check",
      label: "OK",
      title: null,
      tone: "success",
    });
    expect(toolCallStatus(true, true)).toEqual({
      icon: "x",
      label: "Error",
      title: null,
      tone: "danger",
    });
  });

  test("distinguishes a recorded unclassified result from a missing result", () => {
    expect(toolCallStatus(null, true)).toEqual({
      icon: "check",
      label: "Completed",
      title: "A result was recorded, but the source did not classify it as success or error.",
      tone: "neutral",
    });
    expect(toolCallStatus(null, false)).toEqual({
      icon: "minus",
      label: "No result",
      title: "No result was recorded for this call.",
      tone: "neutral",
    });
    expect(toolCallStatus(null, null)).toEqual({
      icon: "minus",
      label: "Unknown",
      title: "This legacy record does not say whether the call produced a result.",
      tone: "neutral",
    });
  });
});
