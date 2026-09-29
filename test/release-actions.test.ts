import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPath,
  CommandFailure,
  capture,
  captureMerged,
  chomp,
  formatAnnotation,
  lastLine,
  retry,
  runChecked,
  runQuiet,
  setOutput,
} from "../scripts/release/actions.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "decant-release-actions-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("release action helpers", () => {
  test("formats workflow annotations and escapes command-breaking characters", () => {
    expect(formatAnnotation("error", "tag v1.0.0 not found")).toBe("::error::tag v1.0.0 not found");
    expect(formatAnnotation("warning", "50% done\r\nnext")).toBe("::warning::50%25 done%0D%0Anext");
    expect(formatAnnotation("notice", "Apache-2.0 §4(d) — ok")).toBe(
      "::notice::Apache-2.0 §4(d) — ok",
    );
  });

  test("appends outputs and PATH entries to the runner command files", () => {
    const dir = tempDir();
    const output = join(dir, "output");
    const path = join(dir, "path");
    setOutput("version", "1.2.3", output);
    setOutput("signed", "true", output);
    addPath("/opt/tools/bin", path);

    expect(readFileSync(output, "utf8")).toBe("version=1.2.3\nsigned=true\n");
    expect(readFileSync(path, "utf8")).toBe("/opt/tools/bin\n");
    expect(() => setOutput("bad", "a\nb", output)).toThrow("multi-line");
  });

  test("prints outputs to stdout when no command file is configured", () => {
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      setOutput("signed", "false", "");
      expect(write).toHaveBeenCalledWith("signed=false\n");
    } finally {
      write.mockRestore();
    }
  });

  test("strips trailing newlines like shell command substitution", () => {
    expect(chomp("0.4.0\n\n")).toBe("0.4.0");
    expect(chomp("a\nb")).toBe("a\nb");
    expect(lastLine("npm notice\ndosu-decant-1.2.3.tgz\n")).toBe("dosu-decant-1.2.3.tgz");
    expect(lastLine("")).toBe("");
  });

  test("runs commands and reports their status", () => {
    expect(runQuiet("sh", ["-c", "exit 3"])).toBe(3);
    expect(capture("sh", ["-c", "printf '%s\\n' \"$GREETING\""], { env: { GREETING: "hi" } })).toBe(
      "hi\n",
    );
    expect(() => runChecked("sh", ["-c", "exit 4"])).toThrow(CommandFailure);
    try {
      runChecked("sh", ["-c", "exit 4"]);
    } catch (cause) {
      expect((cause as CommandFailure).status).toBe(4);
    }
  });

  test("unsets environment variables passed as undefined", () => {
    process.env.DECANT_RELEASE_PROBE = "inherited";
    try {
      expect(capture("env", [])).toContain("DECANT_RELEASE_PROBE=inherited");
      expect(capture("env", [], { env: { DECANT_RELEASE_PROBE: undefined } })).not.toContain(
        "DECANT_RELEASE_PROBE=",
      );
    } finally {
      delete process.env.DECANT_RELEASE_PROBE;
    }
  });

  test("captures all of stdout, then all of stderr, with the exit status", () => {
    const result = captureMerged("sh", ["-c", "echo one; echo two >&2; echo three; exit 2"]);
    expect(result).toEqual({ status: 2, output: "one\nthree\ntwo\n" });
  });

  test("captures a report written only to stderr, the way spctl assesses", () => {
    const result = captureMerged("sh", [
      "-c",
      "echo 'smoke/decant: accepted' >&2; echo 'source=Notarized Developer ID' >&2",
    ]);
    expect(result).toEqual({
      status: 0,
      output: "smoke/decant: accepted\nsource=Notarized Developer ID\n",
    });
  });

  test("retries with a delay after every failed attempt", async () => {
    const sleeps: number[] = [];
    const failures: number[] = [];
    const outcomes = [false, false, true];
    const ok = await retry({
      attempts: 3,
      delayMs: 30_000,
      attempt: (index) => outcomes[index - 1] ?? false,
      onFailure: (index) => failures.push(index),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(ok).toBe(true);
    expect(failures).toEqual([1, 2]);
    expect(sleeps).toEqual([30_000, 30_000]);
  });

  test("gives up after the last attempt, still waiting once more", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const ok = await retry({
      attempts: 2,
      delayMs: 5,
      attempt: () => {
        calls++;
        return false;
      },
      onFailure: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(ok).toBe(false);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([5, 5]);
  });
});
