import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseFailure } from "../scripts/release/actions.ts";
import {
  formatSha256Sums,
  isSha256Hex,
  sha256For,
  sha256Hex,
  sha256Matches,
} from "../scripts/release/checksums.ts";
import {
  deterministicTarArgs,
  isReleaseTarball,
  packageRelease,
  RELEASE_TARGETS,
  tarballName,
} from "../scripts/release/package-release.ts";
import { renderFormula } from "../scripts/release/render-homebrew-formula.ts";

const template = readFileSync(
  join(import.meta.dir, "..", "packaging", "homebrew", "decant.rb.template"),
  "utf8",
);

function digest(fill: string): string {
  return fill.repeat(64);
}

const sums = formatSha256Sums([
  { name: "decant-linux-x64.tar.gz", sha256: digest("d") },
  { name: "decant-darwin-arm64.tar.gz", sha256: digest("a") },
  { name: "decant-linux-arm64.tar.gz", sha256: digest("c") },
  { name: "decant-darwin-x64.tar.gz", sha256: digest("b") },
]);

describe("checksums", () => {
  test("hashes bytes and verifies pinned digests", () => {
    const empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(sha256Hex(new Uint8Array())).toBe(empty);
    expect(sha256Matches(new Uint8Array(), empty.toUpperCase())).toBe(true);
    expect(sha256Matches(new TextEncoder().encode("x"), empty)).toBe(false);
  });

  test("writes SHA256SUMS in sha256sum format, sorted by file name", () => {
    expect(sums).toBe(
      [
        `${digest("a")}  decant-darwin-arm64.tar.gz`,
        `${digest("b")}  decant-darwin-x64.tar.gz`,
        `${digest("c")}  decant-linux-arm64.tar.gz`,
        `${digest("d")}  decant-linux-x64.tar.gz`,
        "",
      ].join("\n"),
    );
  });

  test("looks entries up like awk field matching", () => {
    expect(sha256For(sums, "decant-darwin-x64.tar.gz")).toBe(digest("b"));
    expect(sha256For(sums, "decant-windows-x64.tar.gz")).toBe("");
    const duplicated = `${sums}${digest("e")}  decant-linux-x64.tar.gz\n`;
    expect(sha256For(duplicated, "decant-linux-x64.tar.gz")).toBe(`${digest("d")}\n${digest("e")}`);
    expect(isSha256Hex(sha256For(duplicated, "decant-linux-x64.tar.gz"))).toBe(false);
    expect(isSha256Hex(digest("A"))).toBe(false);
  });
});

describe("release tarballs", () => {
  test("uses GNU tar flags that pin order, ownership, and mtime", () => {
    expect(deterministicTarArgs("dist/bin/linux-x64", "1700000000")).toEqual([
      "--sort=name",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--mtime=@1700000000",
      "-C",
      "dist/bin/linux-x64",
      "-cf",
      "-",
      "decant",
      "LICENSE",
      "NOTICE",
    ]);
  });

  test("names one tarball per release target", () => {
    expect(RELEASE_TARGETS.map(tarballName)).toEqual([
      "decant-darwin-arm64.tar.gz",
      "decant-darwin-x64.tar.gz",
      "decant-linux-arm64.tar.gz",
      "decant-linux-x64.tar.gz",
    ]);
    expect(isReleaseTarball("decant-linux-x64.tar.gz")).toBe(true);
    expect(isReleaseTarball("decant-1.2.3.sigstore.json")).toBe(false);
    expect(isReleaseTarball("SHA256SUMS")).toBe(false);
  });
});

const gnuTar = spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout?.includes("GNU tar");

describe("release packaging", () => {
  test.skipIf(!gnuTar)("produces byte-identical tarballs and matching SHA256SUMS", async () => {
    const root = mkdtempSync(join(tmpdir(), "decant-release-package-"));
    try {
      writeFileSync(join(root, "LICENSE"), "license\n");
      writeFileSync(join(root, "NOTICE"), "notice\n");
      for (const target of RELEASE_TARGETS) {
        mkdirSync(join(root, "bin", target), { recursive: true });
        writeFileSync(join(root, "bin", target, "decant"), `#!/bin/sh\necho ${target}\n`);
      }
      const options = {
        binDir: join(root, "bin"),
        licenseDir: root,
        sourceDateEpoch: "1700000000",
      };
      const first = await packageRelease({ ...options, releaseDir: join(root, "one") });
      const second = await packageRelease({ ...options, releaseDir: join(root, "two") });

      expect(first).toBe(second);
      expect(readFileSync(join(root, "one", "SHA256SUMS"), "utf8")).toBe(first);
      for (const target of RELEASE_TARGETS) {
        const bytes = readFileSync(join(root, "one", tarballName(target)));
        expect(first).toContain(`${sha256Hex(bytes)}  ${tarballName(target)}\n`);
        const listing = spawnSync(
          "tar",
          ["--list", "--verbose", "--numeric-owner", "-zf", join(root, "one", tarballName(target))],
          { encoding: "utf8", env: { ...process.env, TZ: "UTC" } },
        ).stdout;
        expect(listing).toMatch(/ 0\/0 .* 2023-11-14 22:13 LICENSE\n/);
        expect(
          listing
            .trim()
            .split("\n")
            .map((line) => line.split(" ").at(-1)),
        ).toEqual(["decant", "LICENSE", "NOTICE"]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Homebrew formula rendering", () => {
  test("strips template doc lines and fills every placeholder", () => {
    const formula = renderFormula(template, "1.2.3", sums);
    expect(formula).not.toMatch(/^##/m);
    expect(formula).not.toContain("__");
    expect(formula.startsWith("class Decant < Formula\n")).toBe(true);
    expect(formula).toContain(
      'url "https://github.com/dosu-ai/decant/releases/download/v1.2.3/decant-darwin-arm64.tar.gz"',
    );
    for (const fill of ["a", "b", "c", "d"]) {
      expect(formula).toContain(`sha256 "${digest(fill)}"`);
    }
    expect(formula.endsWith("end\n")).toBe(true);
  });

  test("matches the sed rendering byte for byte", () => {
    const sed = spawnSync(
      "sed",
      [
        "-e",
        "/^##/d",
        "-e",
        "s/__VERSION__/0.4.0-rc.1/g",
        "-e",
        `s/__SHA256_DARWIN_ARM64__/${digest("a")}/g`,
        "-e",
        `s/__SHA256_DARWIN_X64__/${digest("b")}/g`,
        "-e",
        `s/__SHA256_LINUX_ARM64__/${digest("c")}/g`,
        "-e",
        `s/__SHA256_LINUX_X64__/${digest("d")}/g`,
      ],
      { input: template, encoding: "utf8" },
    );
    expect(sed.status).toBe(0);
    expect(renderFormula(template, "0.4.0-rc.1", sums)).toBe(sed.stdout);
  });

  test("keeps indented comments and inline ## text", () => {
    expect(renderFormula("## doc\n  ## kept\nx ## kept\n", "1.0.0", sums)).toBe(
      "  ## kept\nx ## kept\n",
    );
  });

  test("refuses a SHA256SUMS that is missing or duplicates a target", () => {
    const missing = sums
      .split("\n")
      .filter((line) => !line.includes("linux-arm64"))
      .join("\n");
    expect(() => renderFormula(template, "1.2.3", missing)).toThrow(
      new ReleaseFailure("missing or malformed sha256 in SHA256SUMS"),
    );
    expect(() =>
      renderFormula(template, "1.2.3", `${sums}${digest("f")}  decant-darwin-x64.tar.gz\n`),
    ).toThrow(ReleaseFailure);
  });
});
