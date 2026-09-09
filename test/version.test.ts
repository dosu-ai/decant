import { describe, expect, test } from "bun:test";
import { resolveDecantVersion } from "../src/version.ts";

describe("version resolution", () => {
  test("prefers the build version over checkout metadata", () => {
    expect(
      resolveDecantVersion({
        env: { DECANT_BUILD_VERSION: "1.2.3" },
        describe: () => "v1.0.0-2-gabcdef",
      }),
    ).toBe("1.2.3");
  });

  test("uses checkout metadata for source runs", () => {
    expect(
      resolveDecantVersion({
        env: {},
        checkoutDir: "/tmp/decant",
        describe: (dir) => (dir === "/tmp/decant" ? "v1.0.0-2-gabcdef" : null),
      }),
    ).toBe("v1.0.0-2-gabcdef");
  });

  test("falls back to dev outside a checkout", () => {
    expect(resolveDecantVersion({ env: {}, describe: () => null })).toBe("dev");
  });
});
