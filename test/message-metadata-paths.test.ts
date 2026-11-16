import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { METADATA_PATHS } from "../src/message-storage.ts";

async function metadataPathsReadInSql(): Promise<Map<string, string>> {
  const root = join(import.meta.dir, "..");
  const read = new Map<string, string>();
  for (const pattern of ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts"]) {
    for await (const file of new Bun.Glob(pattern).scan(root)) {
      const source = readFileSync(join(root, file), "utf8");
      for (const call of source.matchAll(/\$\{MESSAGE_METADATA_SQL\}((?:\s*,\s*'\$[^']*')+)/g)) {
        for (const path of (call[1] ?? "").matchAll(/'\$\.([^']*)'/g)) {
          read.set(path[1] ?? "", file);
        }
      }
    }
  }
  return read;
}

test("every metadata path a SQL reader extracts is kept in the projection", async () => {
  const kept = METADATA_PATHS.map((path) => path.join("."));
  const read = await metadataPathsReadInSql();
  expect(read.size).toBeGreaterThan(10);
  const missing = [...read]
    .filter(([path]) => !kept.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)))
    .map(([path, file]) => `${file}: $.${path}`);
  expect(missing).toEqual([]);
});
