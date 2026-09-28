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
