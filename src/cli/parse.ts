import { InvalidArgumentError } from "commander";

export type OutputFormat = "table" | "json" | "md";

export function parseOutputFormat(value: string): OutputFormat {
  if (value === "table" || value === "json" || value === "md") {
    return value;
  }
  throw new InvalidArgumentError("expected: table | json | md");
}

export function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError("expected an integer");
  }
  return parsed;
}

export function parseNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError("expected a number");
  }
  return parsed;
}

export function optionalInteger(value: string | undefined): number | undefined {
  return value == null ? undefined : parseInteger(value);
}

export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
