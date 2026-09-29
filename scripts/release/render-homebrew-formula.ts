#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fail, requireEnv, runMain } from "./actions.ts";
import { isSha256Hex, sha256For } from "./checksums.ts";

export const FORMULA_TARGETS = {
  __SHA256_DARWIN_ARM64__: "darwin-arm64",
  __SHA256_DARWIN_X64__: "darwin-x64",
  __SHA256_LINUX_ARM64__: "linux-arm64",
  __SHA256_LINUX_X64__: "linux-x64",
} as const;

export function formulaDigests(sums: string): Record<keyof typeof FORMULA_TARGETS, string> {
  const digests = {} as Record<keyof typeof FORMULA_TARGETS, string>;
  for (const [placeholder, target] of Object.entries(FORMULA_TARGETS)) {
    const digest = sha256For(sums, `decant-${target}.tar.gz`);
    if (!isSha256Hex(digest)) {
      fail("missing or malformed sha256 in SHA256SUMS");
    }
    digests[placeholder as keyof typeof FORMULA_TARGETS] = digest;
  }
  return digests;
}

export function renderFormula(template: string, version: string, sums: string): string {
  const replacements: Record<string, string> = { __VERSION__: version, ...formulaDigests(sums) };
  return template
    .split("\n")
    .filter((line) => !line.startsWith("##"))
    .map((line) =>
      Object.entries(replacements).reduce(
        (rendered, [token, value]) => rendered.replaceAll(token, () => value),
        line,
      ),
    )
    .join("\n");
}

function main(): void {
  const version = requireEnv("VERSION");
  const output = "dist/homebrew/decant.rb";
  const formula = renderFormula(
    readFileSync("packaging/homebrew/decant.rb.template", "utf8"),
    version,
    readFileSync("dist/release/SHA256SUMS", "utf8"),
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, formula);
}

if (import.meta.main) {
  runMain(main);
}
