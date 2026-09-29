import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Matches(bytes: Uint8Array, expected: string): boolean {
  return sha256Hex(bytes) === expected.toLowerCase();
}

/** Renders `sha256sum` output: `<hex>  <name>` lines in byte order of the name. */
export function formatSha256Sums(entries: ReadonlyArray<{ name: string; sha256: string }>): string {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => `${entry.sha256}  ${entry.name}\n`)
    .join("");
}

/**
 * Looks up `file` in SHA256SUMS text the way `awk '$2 == file { print $1 }'`
 * does, so a duplicate entry yields two lines and fails digest validation.
 */
export function sha256For(sums: string, file: string): string {
  return sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[1] === file)
    .map((fields) => fields[0])
    .join("\n");
}

export function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
