#!/usr/bin/env bun
import { type Env, log, runMain, setOutput, warning } from "./actions.ts";

export const SIGNING_SECRETS = [
  "MACOS_CERT_P12_B64",
  "MACOS_CERT_PASSWORD",
  "ASC_ISSUER_ID",
  "ASC_KEY_ID",
  "ASC_KEY_P8",
] as const;

export function missingSigningSecrets(env: Env): string[] {
  return SIGNING_SECRETS.filter((name) => env[name] == null || env[name] === "");
}

export function adHocFallbackWarning(missing: number): string {
  return `${missing} of 5 Apple signing secrets are missing — falling back to AD-HOC signing. The darwin binaries will NOT be Developer ID-signed or notarized, and macOS users will get a Gatekeeper prompt on first run that they must clear by hand. Configure all five secrets to publish notarized builds.`;
}

function main(): void {
  const missing = missingSigningSecrets(process.env);
  for (const name of missing) {
    warning(`secret ${name} is not configured`);
  }
  if (missing.length === 0) {
    log("signing mode: Developer ID (sign + notarize)");
    setOutput("signed", "true");
  } else {
    warning(adHocFallbackWarning(missing.length));
    setOutput("signed", "false");
  }
}

if (import.meta.main) {
  runMain(main);
}
