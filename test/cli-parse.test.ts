import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { CliError } from "../src/cli/errors.ts";
import {
  assertFormatSupported,
  InvalidChoiceError,
  installValueValidation,
  parseChoice,
  parseFraction,
  parseInteger,
  parseNumber,
  parseOutputFormat,
  parsePort,
  parsePositiveInteger,
  parseWith,
} from "../src/cli/parse.ts";
import { TOOLS } from "../src/model.ts";

describe("parseInteger", () => {
  test("accepts whole integers", () => {
    expect(parseInteger("42")).toBe(42);
    expect(parseInteger("-3")).toBe(-3);
    expect(parseInteger(" 7 ")).toBe(7);
  });

  test("rejects values with a trailing non-digit part", () => {
    // A source session id must not resolve to whatever archive id its digit prefix names.
    expect(() => parseInteger("0123abcd-0000-4000-8000-000000000000")).toThrow(
      "expected an integer",
    );
    expect(() => parseInteger("42fe0000")).toThrow("expected an integer");
    expect(() => parseInteger("10abc")).toThrow("expected an integer");
    expect(() => parseInteger("1.5")).toThrow("expected an integer");
    expect(() => parseInteger("")).toThrow("expected an integer");
  });
});

describe("parsePositiveInteger", () => {
  test("accepts one and up", () => {
    expect(parsePositiveInteger("1")).toBe(1);
    expect(parsePositiveInteger("250")).toBe(250);
    expect(parsePositiveInteger(" +7 ")).toBe(7);
  });

  test("rejects zero, negatives, fractions, and text", () => {
    for (const value of ["0", "-5", "1.5", "abc", "", "10abc"]) {
      expect(() => parsePositiveInteger(value)).toThrow("expected a positive integer");
    }
  });
});

describe("parsePort", () => {
  test("accepts 0 through 65535", () => {
    expect(parsePort("0")).toBe(0);
    expect(parsePort("3000")).toBe(3000);
    expect(parsePort("65535")).toBe(65_535);
  });

  test("rejects anything outside that range", () => {
    for (const value of ["65536", "-1", "http", "30.5", ""]) {
      expect(() => parsePort(value)).toThrow("expected a port from 0 to 65535");
    }
  });
});

describe("parseNumber and parseFraction", () => {
  test("parseNumber rejects a number followed by text", () => {
    expect(parseNumber("0.25")).toBe(0.25);
    expect(() => parseNumber("0.5abc")).toThrow("expected a number");
    expect(() => parseNumber("")).toThrow("expected a number");
  });

  test("parseFraction keeps to 0.0 through 1.0", () => {
    expect(parseFraction("0")).toBe(0);
    expect(parseFraction("0.25")).toBe(0.25);
    expect(parseFraction("1")).toBe(1);
    for (const value of ["2", "-0.1", "half", ""]) {
      expect(() => parseFraction(value)).toThrow("expected a number from 0.0 to 1.0");
    }
  });
});

describe("parseChoice and parseWith", () => {
  test("parseChoice returns the value or lists the accepted ones", () => {
    const parse = parseChoice(["path", "ext"]);
    expect(parse("ext")).toBe("ext");
    let error: unknown;
    try {
      parse("dir");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidChoiceError);
    expect((error as InvalidChoiceError).message).toBe("expected: path | ext");
    expect((error as InvalidChoiceError).expected).toEqual(["path", "ext"]);
  });

  test("parseOutputFormat accepts the three formats", () => {
    expect(parseOutputFormat("md")).toBe("md");
    expect(() => parseOutputFormat("yaml")).toThrow("expected: table | json | md");
  });

  test("parseWith defers to a core parser, aliases included", () => {
    const parse = parseWith((value) => (value === "sh" || value === "bash" ? "sh" : null), ["sh"]);
    expect(parse("bash")).toBe("sh");
    expect(() => parse("fish")).toThrow("expected: sh");
  });
});

describe("installValueValidation", () => {
  function program(): Command {
    const root = new Command().exitOverride().option("--format <format>", "", parseOutputFormat);
    root.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    const ls = root.command("ls").option("--tool <tool>").option("--limit <n>", "", parseInteger);
    ls.action(() => {});
    root
      .command("show")
      .argument("<id>", "", parseInteger)
      .action(() => {});
    installValueValidation(root);
    return root;
  }

  function failure(argv: string[]): CliError {
    try {
      program().parse(argv, { from: "user" });
    } catch (error) {
      return error as CliError;
    }
    throw new Error(`expected ${argv.join(" ")} to fail`);
  }

  test("checks --tool against the known tools without the command declaring a parser", () => {
    const error = failure(["ls", "--tool", "claude"]);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: "invalid_argument",
      exitCode: 2,
      message: `option '--tool <tool>' argument 'claude' is invalid. expected: ${TOOLS.join(" | ")}`,
      details: { option: "--tool", value: "claude", expected: [...TOOLS] },
    });
    const ok = program();
    ok.parse(["ls", "--tool", "codex"], { from: "user" });
    expect(ok.commands[0]?.opts()).toEqual({ tool: "codex" });
  });

  test("requires a positive --limit wherever the flag appears", () => {
    for (const value of ["0", "-1", "abc"]) {
      expect(failure(["ls", "--limit", value])).toMatchObject({
        code: "invalid_argument",
        message: `option '--limit <n>' argument '${value}' is invalid. expected a positive integer`,
        details: { option: "--limit", value },
      });
    }
    const ok = program();
    ok.parse(["ls", "--limit", "5"], { from: "user" });
    expect(ok.commands[0]?.opts()).toEqual({ limit: 5 });
  });

  test("reports a bad positional argument by name", () => {
    expect(failure(["show", "abc"])).toMatchObject({
      code: "invalid_argument",
      message: "command-argument value 'abc' is invalid for argument 'id'. expected an integer",
      details: { argument: "id", value: "abc" },
    });
  });

  test("covers flags on the root command", () => {
    expect(failure(["--format", "yaml", "ls"])).toMatchObject({
      code: "invalid_argument",
      details: { option: "--format", value: "yaml", expected: ["table", "json", "md"] },
    });
  });
});

describe("assertFormatSupported", () => {
  test("accepts md only where a command prints Markdown", () => {
    for (const path of ["show", "session show", "export", "distill skill"]) {
      expect(() => assertFormatSupported(path, "md")).not.toThrow();
    }
    for (const path of ["ls", "session ls", "stats", "search", "project ls", "db info", "sync"]) {
      expect(() => assertFormatSupported(path, "md")).toThrow(
        `option '--format <format>' argument 'md' is invalid for 'decant ${path}'. expected: table | json`,
      );
    }
  });

  test("leaves table, json, and no format alone", () => {
    for (const format of ["table", "json", undefined] as const) {
      expect(() => assertFormatSupported("ls", format)).not.toThrow();
      expect(() => assertFormatSupported("show", format)).not.toThrow();
    }
  });
});
