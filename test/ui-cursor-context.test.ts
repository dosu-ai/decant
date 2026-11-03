import { describe, expect, test } from "bun:test";
import { cleanSessionTitle, cursorUserQuery } from "../src/ui/session-title.ts";
import { tocPresentation } from "../src/ui/thread-toc.tsx";
import { specialTranscriptBlock } from "../src/ui/transcript.tsx";

const prompt =
  "<timestamp>Monday, Jul 14, 2025, 10:30 AM (UTC+0)</timestamp>\n<user_query>\nList the demo's exports.\n</user_query>";

describe("Cursor CLI transcript context", () => {
  test("a wrapped prompt reads as the text the user typed", () => {
    expect(cursorUserQuery(prompt)).toBe("List the demo's exports.");
    expect(cursorUserQuery("<user_query>\nNo timestamp.\n</user_query>")).toBe("No timestamp.");
    expect(cursorUserQuery("Plain prompt mentioning <user_query> inline")).toBeNull();
    expect(cleanSessionTitle(prompt)).toBe("List the demo's exports.");
    expect(tocPresentation(prompt).label).toBe("List the demo's exports.");
  });

  test("the injected environment block and reminders render as context cards", () => {
    const env = specialTranscriptBlock(
      "<user_info>\nOS Version: synthetic\n\nShell: zsh\n\nWorkspace Path: /Users/dev/cli-demo\n</user_info>",
    );
    expect(env).toMatchObject({ title: "Environment context", chips: [".../dev/cli-demo", "zsh"] });
    expect(
      specialTranscriptBlock("<system_reminder>\nYou are a subagent.\n</system_reminder>"),
    ).toMatchObject({
      title: "Agent context",
    });
    expect(cleanSessionTitle("<user_info>\nShell: zsh\n</user_info>")).toBe("Environment context");
    expect(specialTranscriptBlock(prompt)).toBeNull();
  });
});
