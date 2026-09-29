import { readFileSync } from "node:fs";
import { join } from "node:path";

export function packageName(packageDir: string): string {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    name?: unknown;
  };
  if (typeof manifest.name !== "string") {
    throw new Error(`${packageDir}/package.json has no name`);
  }
  return manifest.name;
}
