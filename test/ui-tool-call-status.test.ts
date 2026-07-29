import { describe, expect, test } from "bun:test";
import { toolCallStatus } from "../src/ui/tool-call-status.ts";

describe("tool call status", () => {
  test("distinguishes confirmed success and error with icon and tone metadata", () => {
    expect(toolCallStatus(false)).toEqual({
      icon: "check",
      label: "OK",
      title: null,
      tone: "success",
    });
    expect(toolCallStatus(true)).toEqual({
      icon: "x",
      label: "Error",
      title: null,
      tone: "danger",
    });
  });

  test("keeps every indeterminate archive result explicitly unknown", () => {
    expect(toolCallStatus(null)).toEqual({
      icon: "minus",
      label: "Unknown",
      title: "The archive can't determine whether this call failed.",
      tone: "neutral",
    });
  });
});
