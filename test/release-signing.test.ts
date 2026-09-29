import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseFailure } from "../scripts/release/actions.ts";
import {
  RCODESIGN_SHA256,
  RCODESIGN_VERSION,
  rcodesignUrl,
} from "../scripts/release/install-rcodesign.ts";
import { notarizeWithRetry, withPrivateDir } from "../scripts/release/sign-darwin.ts";
import {
  adHocFallbackWarning,
  missingSigningSecrets,
  SIGNING_SECRETS,
} from "../scripts/release/signing-mode.ts";
import { judgeSpctl, parseSignedFlag } from "../scripts/release/smoke-darwin.ts";

let stdout: Mock<typeof process.stdout.write>;

beforeEach(() => {
  stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdout.mockRestore();
});

function printed(): string[] {
  return stdout.mock.calls.map((call) => String(call[0]));
}

describe("signing mode", () => {
  const complete = Object.fromEntries(SIGNING_SECRETS.map((name) => [name, "value"]));

  test("is Developer ID only when all five secrets are non-empty", () => {
    expect(missingSigningSecrets(complete)).toEqual([]);
    expect(missingSigningSecrets({ ...complete, ASC_KEY_ID: "" })).toEqual(["ASC_KEY_ID"]);
    expect(missingSigningSecrets({})).toEqual([...SIGNING_SECRETS]);
  });

  test("keeps the ad-hoc fallback warning text", () => {
    expect(adHocFallbackWarning(2)).toBe(
      "2 of 5 Apple signing secrets are missing — falling back to AD-HOC signing. The darwin binaries will NOT be Developer ID-signed or notarized, and macOS users will get a Gatekeeper prompt on first run that they must clear by hand. Configure all five secrets to publish notarized builds.",
    );
  });
});

describe("rcodesign pin", () => {
  test("downloads the pinned musl build", () => {
    expect(RCODESIGN_VERSION).toBe("0.29.0");
    expect(RCODESIGN_SHA256).toBe(
      "dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002",
    );
    expect(rcodesignUrl()).toBe(
      "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz",
    );
  });
});

describe("notarization retry", () => {
  test("stops at the first accepted submission", async () => {
    const sleeps: number[] = [];
    const results = [false, true];
    let calls = 0;
    await notarizeWithRetry({
      target: "darwin-arm64",
      submit: () => results[calls++] ?? false,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([30_000]);
    expect(printed()).toEqual([
      "::warning::notary-submit attempt 1 failed for darwin-arm64 — retrying\n",
    ]);
  });

  test("fails after three rejected submissions", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const attempt = notarizeWithRetry({
      target: "darwin-x64",
      submit: () => {
        calls++;
        return false;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(attempt).rejects.toThrow(
      new ReleaseFailure("notarization failed for darwin-x64 after 3 attempts"),
    );
    expect(calls).toBe(3);
    expect(sleeps).toEqual([30_000, 30_000, 30_000]);
    expect(printed()).toHaveLength(3);
  });
});

describe("key material directory", () => {
  test("is private and removed even when signing throws", async () => {
    const parent = mkdtempSync(join(tmpdir(), "decant-release-sign-"));
    let seen = "";
    try {
      await expect(
        withPrivateDir(parent, async (dir) => {
          seen = dir;
          expect(statSync(dir).mode & 0o777).toBe(0o700);
          throw new Error("rcodesign failed");
        }),
      ).rejects.toThrow("rcodesign failed");
      expect(seen.startsWith(join(parent, "sign."))).toBe(true);
      expect(existsSync(seen)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("darwin smoke gate", () => {
  test("requires build to report true or false", () => {
    expect(parseSignedFlag("true")).toBe(true);
    expect(parseSignedFlag("false")).toBe(false);
    expect(() => parseSignedFlag("")).toThrow(
      "build reported no signing mode (got '') — cannot decide whether the Gatekeeper gate applies",
    );
    expect(() => parseSignedFlag(undefined)).toThrow(ReleaseFailure);
  });

  test("accepts only a notarized Developer ID assessment", () => {
    expect(judgeSpctl(0, "smoke/decant: accepted\nsource=Notarized Developer ID\n")).toEqual({
      accepted: true,
      message: "spctl assessment: Notarized Developer ID",
    });
    expect(judgeSpctl(0, "smoke/decant: accepted\nsource=Developer ID\n")).toEqual({
      accepted: false,
      message: "expected a 'Notarized Developer ID' spctl assessment",
    });
    expect(judgeSpctl(3, "smoke/decant: rejected\nsource=Notarized Developer ID\n")).toEqual({
      accepted: false,
      message: "spctl rejected the binary — Gatekeeper would block users",
    });
  });
});
