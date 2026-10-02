import { expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const uiDir = join(import.meta.dir, "..", "src", "ui");

/** Every UI module (src/ui recursively, .ts and .tsx), relative to src/ui, in sorted order. */
export function uiSourceFiles(): string[] {
  return readdirSync(uiDir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .sort();
}

export function readUiFile(name: string): string {
  return readFileSync(join(uiDir, name), "utf8");
}

/** All UI modules concatenated, so copy and contract checks survive moving code between files. */
export function readUiSource(exclude: string[] = []): string {
  return uiSourceFiles()
    .filter((file) => !exclude.includes(file))
    .map((file) => readUiFile(file))
    .join("\n");
}

/** Slices `start` up to the next `end`, failing loudly instead of returning an empty string. */
export function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

/** Slices from `start` to the end of `source`, failing when `start` is missing. */
export function sourceFrom(source: string, start: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  return source.slice(startIndex);
}
