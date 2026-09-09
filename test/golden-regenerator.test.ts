import { expect, test } from "bun:test";
import { join } from "node:path";

test("golden regenerator refuses to rewrite snapshots without an explicit review flag", async () => {
  const proc = Bun.spawn(["bun", "scripts/regen-goldens.ts"], {
    cwd: join(import.meta.dir, ".."),
    stderr: "pipe",
  });
  expect(await proc.exited).not.toBe(0);
  expect(await new Response(proc.stderr).text()).toContain("--i-reviewed-the-diff");
});
