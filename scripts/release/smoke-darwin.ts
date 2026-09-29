#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import {
  captureMerged,
  chomp,
  fail,
  log,
  requireEnv,
  run,
  runChecked,
  runMain,
  warning,
} from "./actions.ts";
import { DARWIN_TARGETS } from "./sign-darwin.ts";
import { oneOf } from "./validate.ts";

export interface SpctlVerdict {
  accepted: boolean;
  message: string;
}

export function parseSignedFlag(value: string | undefined): boolean {
  if (value === "true" || value === "false") {
    return value === "true";
  }
  fail(
    `build reported no signing mode (got '${value ?? ""}') — cannot decide whether the Gatekeeper gate applies`,
  );
}

export function judgeSpctl(status: number, output: string): SpctlVerdict {
  if (status !== 0) {
    return { accepted: false, message: "spctl rejected the binary — Gatekeeper would block users" };
  }
  if (!output.includes("Notarized Developer ID")) {
    return { accepted: false, message: "expected a 'Notarized Developer ID' spctl assessment" };
  }
  return { accepted: true, message: "spctl assessment: Notarized Developer ID" };
}

function main(): void {
  const target = oneOf("TARGET", requireEnv("TARGET"), DARWIN_TARGETS);
  const binary = "smoke/decant";
  const spctlArgs = ["-a", "-t", "exec", "-vv", binary];

  mkdirSync("smoke", { recursive: true });
  runChecked("tar", ["-xzf", `dist/release/decant-${target}.tar.gz`, "-C", "smoke"]);
  runChecked(`./${binary}`, ["--version"]);
  runChecked("codesign", ["--verify", "--strict", "--verbose=2", binary]);

  if (!parseSignedFlag(process.env.SIGNED)) {
    warning(
      "ad-hoc signed build — reporting the spctl assessment for information only (a Developer ID build must pass it)",
    );
    run("spctl", spctlArgs);
    return;
  }

  const { status, output } = captureMerged("spctl", spctlArgs);
  log(chomp(output));
  const verdict = judgeSpctl(status, output);
  if (!verdict.accepted) {
    fail(verdict.message);
  }
  log(verdict.message);
}

if (import.meta.main) {
  runMain(main);
}
