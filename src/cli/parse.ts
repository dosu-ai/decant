import { type Command, InvalidArgumentError } from "commander";
import { TOOLS } from "../model.ts";
import { type CliErrorDetails, usageError } from "./errors.ts";

export const OUTPUT_FORMATS = ["table", "json", "md"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** An invalid value that lists the accepted ones, so the JSON error can too. */
export class InvalidChoiceError extends InvalidArgumentError {
  constructor(readonly expected: readonly string[]) {
    super(`expected: ${expected.join(" | ")}`);
  }
}

export function parseChoice<const T extends string>(values: readonly T[]): (value: string) => T {
  return (value) => {
    if ((values as readonly string[]).includes(value)) {
      return value as T;
    }
    throw new InvalidChoiceError(values);
  };
}

/** For a flag whose core parser also accepts aliases, such as `bash` for `sh`. */
export function parseWith<T>(
  parse: (value: string) => T | null,
  expected: readonly string[],
): (value: string) => T {
  return (value) => {
    const parsed = parse(value);
    if (parsed == null) {
      throw new InvalidChoiceError(expected);
    }
    return parsed;
  };
}

export const parseOutputFormat = parseChoice(OUTPUT_FORMATS);

export function parseInteger(value: string): number {
  // Number.parseInt reads a leading digit run and ignores the rest, which
  // turned a UUID source session id into a small archive id.
  if (!/^\s*[+-]?\d+\s*$/.test(value)) {
    throw new InvalidArgumentError("expected an integer");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError("expected an integer");
  }
  return parsed;
}

/** Row limits: the queries fall back to their default for zero or less. */
export function parsePositiveInteger(value: string): number {
  if (!/^\s*\+?\d+\s*$/.test(value) || Number.parseInt(value, 10) < 1) {
    throw new InvalidArgumentError("expected a positive integer");
  }
  return parseInteger(value);
}

export function parsePort(value: string): number {
  if (!/^\s*\d+\s*$/.test(value) || Number.parseInt(value, 10) > 65_535) {
    throw new InvalidArgumentError("expected a port from 0 to 65535");
  }
  return parseInteger(value);
}

export function parseNumber(value: string): number {
  // Number.parseFloat reads a leading number and ignores the rest.
  const parsed = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError("expected a number");
  }
  return parsed;
}

export function parseFraction(value: string): number {
  let parsed = Number.NaN;
  try {
    parsed = parseNumber(value);
  } catch {
    // Reported below with the range.
  }
  if (!(parsed >= 0 && parsed <= 1)) {
    throw new InvalidArgumentError("expected a number from 0.0 to 1.0");
  }
  return parsed;
}

export function optionalInteger(value: string | undefined): number | undefined {
  return value == null ? undefined : parseInteger(value);
}

export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

type ValueParser = (value: string, previous: unknown) => unknown;

// Flags that mean the same on every command are validated here by name, so a
// command that adds `--limit` or `--tool` gets the check without repeating it.
const SHARED_FLAG_PARSERS: Record<string, ValueParser> = {
  "--limit": parsePositiveInteger,
  "--tool": parseChoice(TOOLS),
};

/**
 * Route every flag and argument parser of `command` and its subcommands
 * through one error shape. Call it after all commands are registered.
 */
export function installValueValidation(command: Command): void {
  for (const option of command.options) {
    const parse = SHARED_FLAG_PARSERS[option.long ?? ""] ?? (option.parseArg as ValueParser);
    if (parse != null && (option.required || option.optional)) {
      option.argParser((value: string, previous: unknown) =>
        validated(() => parse(value, previous), {
          message: `option '${option.flags}' argument '${value}' is invalid.`,
          details: { option: option.long ?? option.flags, value },
        }),
      );
    }
  }
  for (const argument of command.registeredArguments) {
    const parse = argument.parseArg as ValueParser | undefined;
    if (parse != null) {
      argument.argParser((value: string, previous: unknown) =>
        validated(() => parse(value, previous), {
          message: `command-argument value '${value}' is invalid for argument '${argument.name()}'.`,
          details: { argument: argument.name(), value },
        }),
      );
    }
  }
  for (const subcommand of command.commands) {
    installValueValidation(subcommand);
  }
}

function validated<T>(parse: () => T, context: { message: string; details: CliErrorDetails }): T {
  try {
    return parse();
  } catch (error) {
    if (!(error instanceof InvalidArgumentError)) {
      throw error;
    }
    throw usageError("invalid_argument", `${context.message} ${error.message}`, {
      ...context.details,
      ...(error instanceof InvalidChoiceError ? { expected: error.expected } : {}),
    });
  }
}

// Commands whose human-readable output is Markdown. The rest print rows.
const MARKDOWN_COMMANDS = new Set(["show", "session show", "export", "distill skill"]);

/** `--format` is global, so the command it lands on has to say whether it can render it. */
export function assertFormatSupported(commandPath: string, format: OutputFormat | undefined): void {
  if (format !== "md" || MARKDOWN_COMMANDS.has(commandPath)) {
    return;
  }
  const expected = OUTPUT_FORMATS.filter((value) => value !== "md");
  throw usageError(
    "invalid_argument",
    `option '--format <format>' argument 'md' is invalid for 'decant ${commandPath}'. ` +
      `expected: ${expected.join(" | ")}`,
    { option: "--format", value: "md", expected, command: commandPath },
  );
}
