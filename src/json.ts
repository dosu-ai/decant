// Every JSON TEXT column in the archive (`message.raw`, `session.raw_meta`,
// `block.tool_input`, stringified unknown blocks) is stored with recursively
// sorted keys and compact separators, so the same record always serializes to
// the same bytes and goldens can compare it directly. JSON.stringify supplies
// the string escaping and number formatting; the delta is key order, which must
// be Unicode code-point order (UTF-8 byte order), not JS UTF-16 order.
import type { Json } from "./model.ts";
import { compareCodePoints } from "./order.ts";

/** Serialize a JSON value with keys sorted by code point at every depth. */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const parts = Object.keys(value)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`);
  return `{${parts.join(",")}}`;
}

export type JsonObject = { [key: string]: Json };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function get(value: Json | undefined, key: string): Json | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return value[key];
}

export function hasKey(value: Json | undefined, key: string): boolean {
  return isObject(value) && Object.hasOwn(value, key);
}

export function asString(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export function asBoolean(value: Json | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Rejects floats rather than truncating them. */
export function asInteger(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

const utf8 = new TextEncoder();

/** Buffer.byteLength counts a lone surrogate as 2 bytes; SQLite stores it as
 * U+FFFD (3), which is what the encoder reports. */
export function byteLength(value: string): number {
  return utf8.encode(value).length;
}
