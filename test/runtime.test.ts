import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { closeDb, openDb } from "../src/db.ts";
import { bunVersionSupported, MIN_BUN_VERSION } from "../src/runtime.ts";
import { compareVersions, parseVersion } from "../src/update.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-runtime-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("bunVersionSupported", () => {
  test("accepts the minimum and anything newer", () => {
    for (const version of [MIN_BUN_VERSION, "1.4.5", "1.5.0", "2.0.0"]) {
      expect(bunVersionSupported(version)).toBe(true);
    }
  });

  test("rejects the releases whose bun:sqlite drops a leading byte-order mark", () => {
    for (const version of ["1.3.0", "1.3.9", "1.4.0", "1.4.3"]) {
      expect(bunVersionSupported(version)).toBe(false);
    }
  });

  test("never warns about a version it cannot read", () => {
    expect(bunVersionSupported("unknown")).toBe(true);
  });
});

test("the minimum Bun is the one package.json declares and CI pins at or above", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { engines: { bun: string } };
  expect(pkg.engines.bun).toBe(`>=${MIN_BUN_VERSION}`);
  const pinned = parseVersion(readFileSync(".bun-version", "utf8"));
  const minimum = parseVersion(MIN_BUN_VERSION);
  if (pinned == null || minimum == null) throw new Error("unparseable Bun version");
  expect(compareVersions(pinned, minimum)).toBeGreaterThanOrEqual(0);
});

test("the CLI warns a person on an old Bun once, before the command runs", async () => {
  const dbPath = join(workDir, "runtime.db");
  closeDb(openDb(dbPath));
  const ls = (bunVersion: string, flags: string[] = []) =>
    runCli(["--db", dbPath, "--no-sync", ...flags, "ls"], {
      env: { DECANT_CONFIG_DIR: join(workDir, "cfg") },
      update: { stderrIsTTY: true, bunVersion },
    });

  const old = await ls("1.4.3");
  expect(old.code).toBe(0);
  expect(old.stderr).toBe(
    `warning: Bun 1.4.3 is older than ${MIN_BUN_VERSION}, the oldest Bun that runs Decant from source without dropping a leading byte-order mark from stored text. Run: bun upgrade\n`,
  );

  expect((await ls(MIN_BUN_VERSION)).stderr).toBe("");
  const json = await ls("1.4.3", ["--json"]);
  expect(json.code).toBe(0);
  expect(json.stderr).toBe("");
});
