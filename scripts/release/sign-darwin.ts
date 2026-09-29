#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, requireEnv, retry, run, runChecked, runMain, warning } from "./actions.ts";

export const DARWIN_TARGETS = ["darwin-arm64", "darwin-x64"] as const;
export const NOTARY_ATTEMPTS = 3;
export const NOTARY_RETRY_DELAY_MS = 30_000;

export interface NotarizeOptions {
  target: string;
  submit: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Notary submissions can fail transiently, so each target gets three tries. */
export async function notarizeWithRetry(options: NotarizeOptions): Promise<void> {
  const submitted = await retry({
    attempts: NOTARY_ATTEMPTS,
    delayMs: NOTARY_RETRY_DELAY_MS,
    attempt: () => options.submit(),
    onFailure: (attempt) =>
      warning(`notary-submit attempt ${attempt} failed for ${options.target} — retrying`),
    sleep: options.sleep,
  });
  if (!submitted) {
    fail(`notarization failed for ${options.target} after ${NOTARY_ATTEMPTS} attempts`);
  }
}

/** Holds key material in a private temp dir that is removed even when signing fails. */
export async function withPrivateDir<T>(
  parent: string,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(parent, "sign."));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function binaryPath(target: string): string {
  return `dist/bin/${target}/decant`;
}

async function signDeveloperId(): Promise<void> {
  const certP12 = requireEnv("MACOS_CERT_P12_B64");
  const certPassword = requireEnv("MACOS_CERT_PASSWORD");
  const issuerId = requireEnv("ASC_ISSUER_ID");
  const keyId = requireEnv("ASC_KEY_ID");
  const keyP8 = requireEnv("ASC_KEY_P8");

  // Applies to every file this step creates, including rcodesign and zip output.
  process.umask(0o077);
  await withPrivateDir(requireEnv("RUNNER_TEMP"), async (keysDir) => {
    const cert = join(keysDir, "cert.p12");
    const password = join(keysDir, "p12-password");
    const ascKey = join(keysDir, "asc-key.p8");
    const apiKey = join(keysDir, "asc-api-key.json");
    writeFileSync(cert, Buffer.from(certP12, "base64"), { mode: 0o600 });
    writeFileSync(password, certPassword, { mode: 0o600 });
    writeFileSync(ascKey, keyP8, { mode: 0o600 });
    runChecked("rcodesign", [
      "encode-app-store-connect-api-key",
      "-o",
      apiKey,
      issuerId,
      keyId,
      ascKey,
    ]);

    for (const target of DARWIN_TARGETS) {
      runChecked("rcodesign", [
        "sign",
        "--p12-file",
        cert,
        "--p12-password-file",
        password,
        "--for-notarization",
        "-e",
        "entitlements.plist",
        binaryPath(target),
      ]);
      const zip = join(keysDir, `decant-${target}.zip`);
      runChecked("zip", ["-j", "-q", zip, binaryPath(target)]);
      await notarizeWithRetry({
        target,
        submit: () =>
          run("rcodesign", ["notary-submit", "--api-key-file", apiKey, "--wait", zip]) === 0,
      });
    }
  });
}

function signAdHoc(): void {
  for (const target of DARWIN_TARGETS) {
    runChecked("rcodesign", ["sign", binaryPath(target)]);
  }
  warning(
    "darwin binaries are AD-HOC signed — not Developer ID-signed and not notarized. macOS users will see a Gatekeeper prompt on first run.",
  );
}

async function main(): Promise<void> {
  const mode = requireEnv("SIGN_MODE");
  if (mode === "developer-id") {
    await signDeveloperId();
  } else if (mode === "ad-hoc") {
    signAdHoc();
  } else {
    throw new Error(`SIGN_MODE must be developer-id or ad-hoc, got ${JSON.stringify(mode)}`);
  }
}

if (import.meta.main) {
  runMain(main);
}
