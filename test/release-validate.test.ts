import { describe, expect, test } from "bun:test";
import { ReleaseFailure } from "../scripts/release/actions.ts";
import { DARWIN_TARGETS, SIGN_MODES } from "../scripts/release/sign-darwin.ts";
import {
  absolutePath,
  ascIssuerId,
  ascKeyId,
  commitSha,
  oneOf,
  releaseFileName,
  releaseTag,
  releaseVersion,
  safePath,
} from "../scripts/release/validate.ts";

const OPTION_AND_SEPARATOR_TRICKS = [
  "-rf",
  "--upload-pack=touch pwned",
  "a b",
  "a\tb",
  "a\nb",
  "a\rb",
  "a\u0000b",
  "a\u001bb",
  "a;b",
  "a$(b)",
  "a`b`",
  "a|b",
];

function rejects(check: (value: string) => string, values: readonly string[]): void {
  for (const value of values) {
    expect(() => check(value)).toThrow(ReleaseFailure);
  }
}

describe("release version and tag", () => {
  test("accepts semver with an optional prerelease suffix", () => {
    for (const version of ["0.0.1", "1.2.3", "1.2.3-beta.1", "0.0.1-alpha-2.x", "10.20.30"]) {
      expect(releaseVersion(version)).toBe(version);
      expect(releaseTag("TAG", `v${version}`)).toBe(`v${version}`);
    }
  });

  test("rejects non-semver versions and tags without exactly one leading v", () => {
    rejects(releaseVersion, [
      "",
      "1.2",
      "v1.2.3",
      "1.2.3+build",
      "1.2.3-",
      "1.2.3-rc_1",
      "1.2.3 ",
      " 1.2.3",
      "-1.2.3",
      "1.2.3\n",
      "1.2.3-a/b",
      ...OPTION_AND_SEPARATOR_TRICKS,
    ]);
    rejects((value) => releaseTag("TAG", value), ["1.2.3", "vv1.2.3", "-v1.2.3", "v1.2.3 "]);
    expect(() => releaseVersion("1.2")).toThrow("'1.2' is not semver");
    expect(() => releaseTag("TAG", "1.2.3")).toThrow(
      "TAG must be v followed by a semver version, got '1.2.3'",
    );
  });
});

describe("commit SHA", () => {
  test("accepts only a full lowercase hex SHA-1", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(commitSha("GITHUB_SHA", sha)).toBe(sha);
    rejects(
      (value) => commitSha("GITHUB_SHA", value),
      [
        "",
        sha.slice(1),
        `${sha}0`,
        sha.toUpperCase(),
        `-${sha.slice(1)}`,
        `${sha.slice(1)}\n`,
        "HEAD",
        "0123456789abcdef0123456789abcdef0123456g",
      ],
    );
  });
});

describe("allow-lists", () => {
  test("accept only listed values and return them typed", () => {
    for (const target of DARWIN_TARGETS) {
      expect(oneOf("TARGET", target, DARWIN_TARGETS)).toBe(target);
    }
    for (const mode of SIGN_MODES) {
      expect(oneOf("SIGN_MODE", mode, SIGN_MODES)).toBe(mode);
    }
    rejects(
      (value) => oneOf("TARGET", value, DARWIN_TARGETS),
      ["", "linux-x64", "darwin-arm64 ", "DARWIN-ARM64", "-darwin-arm64", "darwin-arm64\n"],
    );
    expect(() => oneOf("SIGN_MODE", "notarize", SIGN_MODES)).toThrow(
      "SIGN_MODE must be one of developer-id, ad-hoc, got 'notarize'",
    );
  });
});

describe("paths", () => {
  test("absolute paths start with a slash and use a safe character set", () => {
    for (const path of ["/home/runner/work/_temp", "/tmp", "/", "/Users/a.b/x+y@z/-leaf"]) {
      expect(absolutePath("RUNNER_TEMP", path)).toBe(path);
    }
    rejects(
      (value) => absolutePath("RUNNER_TEMP", value),
      ["", "relative/dir", "./tmp", "-/tmp", "/tmp/a b", "/tmp\n", "/tmp/\u0000", "/tmp;rm"],
    );
    expect(() => absolutePath("RUNNER_TEMP", "tmp")).toThrow(
      "RUNNER_TEMP must be an absolute path of letters, digits, and ._@+/- characters",
    );
  });

  test("safe paths may be relative but never start with a dash", () => {
    for (const path of ["dist/release", "./dist/release", "/abs/dist", "dist-2/re_lease"]) {
      expect(safePath("RELEASE_DIR", path)).toBe(path);
    }
    rejects((value) => safePath("RELEASE_DIR", value), ["", "--help", "-dist", "dist release"]);
    rejects((value) => safePath("RELEASE_DIR", value), OPTION_AND_SEPARATOR_TRICKS);
  });
});

describe("release file names", () => {
  test("accept single path components made of letters, digits, and ._-", () => {
    for (const name of [
      "decant-darwin-arm64.tar.gz",
      "decant-1.2.3-beta.1.sigstore.json",
      "SHA256SUMS",
      "install.sh",
    ]) {
      expect(releaseFileName(name)).toBe(name);
    }
  });

  test("reject leading dashes or dots, whitespace, control characters, and path separators", () => {
    rejects(releaseFileName, [
      "",
      "-decant.tar.gz",
      ".hidden.tar.gz",
      ".",
      "..",
      "--clobber.tar.gz",
      "decant x.tar.gz",
      "decant\n.tar.gz",
      "decant/../x.tar.gz",
      "decant\\x.tar.gz",
      "decant#label.tar.gz",
      ...OPTION_AND_SEPARATOR_TRICKS,
    ]);
    expect(() => releaseFileName("-x.tar.gz")).toThrow(
      "release file name '-x.tar.gz' must use only letters, digits, and ._- and start with a letter or digit",
    );
  });
});

describe("App Store Connect identifiers", () => {
  test("accept the documented formats and never echo the secret", () => {
    const issuer = "57246542-96fe-1a63-e053-0824d011072a";
    expect(ascIssuerId("ASC_ISSUER_ID", issuer)).toBe(issuer);
    expect(ascIssuerId("ASC_ISSUER_ID", issuer.toUpperCase())).toBe(issuer.toUpperCase());
    expect(ascKeyId("ASC_KEY_ID", "2X9R4HXF34")).toBe("2X9R4HXF34");

    rejects(
      (value) => ascIssuerId("ASC_ISSUER_ID", value),
      ["", `${issuer}\n`, ` ${issuer}`, `-${issuer.slice(1)}`, issuer.replaceAll("-", "")],
    );
    rejects(
      (value) => ascKeyId("ASC_KEY_ID", value),
      ["", "2X9R4HXF3", "2X9R4HXF345", "2x9r4hxf34", "-X9R4HXF34", "2X9R4HXF34\n"],
    );
    for (const [check, secret] of [
      [(value: string) => ascIssuerId("ASC_ISSUER_ID", value), "secret-issuer-value"],
      [(value: string) => ascKeyId("ASC_KEY_ID", value), "secret-key-value"],
    ] as const) {
      try {
        check(secret);
        throw new Error("expected a rejection");
      } catch (cause) {
        expect(cause).toBeInstanceOf(ReleaseFailure);
        expect((cause as Error).message).not.toContain(secret);
      }
    }
  });
});
