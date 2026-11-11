/** Exit codes and error codes are a public contract: docs/cli.md. */
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** Optional fields of the `--json` error object. */
export interface CliErrorDetails {
  option?: string;
  argument?: string;
  value?: string;
  expected?: readonly string[];
  path?: string;
  command?: string;
}

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number = EXIT_FAILURE,
    readonly details: CliErrorDetails = {},
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function usageError(code: string, message: string, details: CliErrorDetails = {}): CliError {
  return new CliError(code, message, EXIT_USAGE, details);
}

// Core modules mark their own failures with a lowercase code (schema_too_new).
// SQLite and fs codes are uppercase and stay behind command_failed.
const CORE_CODE = /^[a-z][a-z0-9_]*$/;

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return new CliError(
    typeof code === "string" && CORE_CODE.test(code) ? code : "command_failed",
    message,
  );
}

const COMMANDER_CODES: Record<string, string> = {
  "commander.unknownCommand": "unknown_command",
  "commander.unknownOption": "unknown_option",
  "commander.missingArgument": "missing_argument",
  "commander.optionMissingArgument": "missing_argument",
  "commander.missingMandatoryOptionValue": "missing_argument",
  "commander.invalidArgument": "invalid_argument",
};

/** Commander's message already starts with "error: ", which `formatCliError` adds back. */
export function fromCommanderError(error: { code?: string; message?: string }): CliError {
  return usageError(
    COMMANDER_CODES[error.code ?? ""] ?? "usage_error",
    stripErrorPrefix(error.message ?? "invalid command line"),
  );
}

/**
 * The code for a failure a command reported by writing an `error:` line and
 * returning an exit code, which is how most commands report one.
 */
export function fromErrorLine(text: string, exitCode: number): CliError {
  const message = stripErrorPrefix(text).trimEnd();
  if (exitCode === EXIT_USAGE) {
    return usageError("usage_error", message);
  }
  return new CliError(
    /^no session with id \d+$/.test(message) ? "session_not_found" : "command_failed",
    message,
    exitCode,
  );
}

export function isErrorLine(text: string): boolean {
  return text.startsWith("error: ");
}

function stripErrorPrefix(text: string): string {
  return isErrorLine(text) ? text.slice("error: ".length) : text;
}

/** One line either way, so a `--json` caller can parse the last line of stderr. */
export function formatCliError(error: CliError, json: boolean): string {
  if (!json) {
    return `error: ${error.message}\n`;
  }
  return `${JSON.stringify({
    error: { code: error.code, message: error.message, ...error.details },
  })}\n`;
}

/** True when argv asks for JSON, for errors raised before the flags are parsed. */
export function argvRequestsJson(argv: readonly string[]): boolean {
  for (const [index, token] of argv.entries()) {
    if (token === "--") {
      return false;
    }
    if (token === "--json" || token === "--format=json") {
      return true;
    }
    if (token === "--format" && argv[index + 1] === "json") {
      return true;
    }
  }
  return false;
}
