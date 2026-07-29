import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { compareCodePoints } from "./order.ts";

interface SchemaColumn {
  name: string;
  type: string;
  not_null: boolean;
  default: string | null;
  primary_key_position: number;
  hidden: number;
}

interface SchemaForeignKey {
  sequence: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
  match: string;
}

interface SchemaIndexKey {
  sequence: number;
  column_id: number | null;
  name: string | null;
  descending: boolean;
  collation: string;
  key: boolean;
}

export interface SchemaObjectManifest {
  type: string;
  name: string;
  table: string;
  ddl: string | null;
  columns: SchemaColumn[];
  foreign_keys: SchemaForeignKey[];
  index_keys: SchemaIndexKey[];
}

export interface SchemaManifest {
  objects: SchemaObjectManifest[];
  fingerprint: string;
}

export interface SchemaDifference {
  missingObjects: string[];
  unexpectedObjects: string[];
  changedObjects: string[];
  missingColumns: string[];
  unexpectedColumns: string[];
}

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string;
  key: number;
}

/**
 * Build a stable manifest of Decant-owned SQLite objects. sqlite_master DDL is
 * canonicalized so harmless whitespace, identifier quoting, IF NOT EXISTS,
 * and regular-table column order do not split otherwise equivalent lineages.
 * Column defaults/types, foreign keys, indexes, triggers, and FTS declarations
 * remain part of the fingerprint.
 */
export function buildSchemaManifest(db: Database): SchemaManifest {
  const shadowTables = new Set(
    (
      db.query("SELECT name FROM pragma_table_list WHERE type = 'shadow'").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  const rows = (
    db
      .query(
        `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY type, name`,
      )
      .all() as MasterRow[]
  ).filter((row) => !shadowTables.has(row.name));

  const objects = rows.map((row): SchemaObjectManifest => {
    const isTable = row.type === "table";
    const columns = isTable
      ? (db.query("SELECT * FROM pragma_table_xinfo(?1)").all(row.name) as TableInfoRow[])
          .map((column) => ({
            name: column.name,
            type: normalizeType(column.type),
            not_null: column.notnull !== 0,
            default: normalizeColumnDefault(row.name, column.name, column.dflt_value),
            primary_key_position: column.pk,
            hidden: column.hidden,
          }))
          .sort((left, right) => left.name.localeCompare(right.name))
      : [];
    const foreignKeys = isTable
      ? (db.query("SELECT * FROM pragma_foreign_key_list(?1)").all(row.name) as ForeignKeyRow[])
          .map((foreignKey) => ({
            sequence: foreignKey.seq,
            table: foreignKey.table,
            from: foreignKey.from,
            to: foreignKey.to,
            on_update: foreignKey.on_update.toUpperCase(),
            on_delete: foreignKey.on_delete.toUpperCase(),
            match: foreignKey.match.toUpperCase(),
          }))
          .sort(compareForeignKeys)
      : [];
    const indexKeys =
      row.type === "index"
        ? (db.query("SELECT * FROM pragma_index_xinfo(?1)").all(row.name) as IndexInfoRow[])
            .map((key) => ({
              sequence: key.seqno,
              // cid is the physical table-column ordinal and legitimately
              // differs when an ALTER-based lineage appends the same named
              // column that the fresh baseline groups semantically.
              column_id: key.name == null ? key.cid : null,
              name: key.name,
              descending: key.desc !== 0,
              collation: key.coll,
              key: key.key !== 0,
            }))
            .sort((left, right) => left.sequence - right.sequence)
        : [];
    return {
      type: row.type,
      name: row.name,
      table: row.tbl_name,
      ddl: row.sql == null ? null : canonicalizeDdl(row.sql, row.name),
      columns,
      foreign_keys: foreignKeys,
      index_keys: indexKeys,
    };
  });

  return {
    objects,
    fingerprint: createHash("sha256").update(JSON.stringify(objects)).digest("hex"),
  };
}

export function compareSchemaManifests(
  expected: SchemaManifest,
  actual: SchemaManifest,
): SchemaDifference {
  const expectedByKey = new Map(expected.objects.map((object) => [objectKey(object), object]));
  const actualByKey = new Map(actual.objects.map((object) => [objectKey(object), object]));
  const missingObjects: string[] = [];
  const unexpectedObjects: string[] = [];
  const changedObjects: string[] = [];
  const missingColumns: string[] = [];
  const unexpectedColumns: string[] = [];

  for (const [key, expectedObject] of expectedByKey) {
    const actualObject = actualByKey.get(key);
    if (actualObject == null) {
      missingObjects.push(key);
      continue;
    }
    if (JSON.stringify(expectedObject) === JSON.stringify(actualObject)) {
      continue;
    }
    if (expectedObject.type === "table") {
      const expectedColumnNames = new Set(expectedObject.columns.map((column) => column.name));
      const actualColumnNames = new Set(actualObject.columns.map((column) => column.name));
      for (const name of expectedColumnNames) {
        if (!actualColumnNames.has(name)) {
          missingColumns.push(`${expectedObject.name}.${name}`);
        }
      }
      for (const name of actualColumnNames) {
        if (!expectedColumnNames.has(name)) {
          unexpectedColumns.push(`${actualObject.name}.${name}`);
        }
      }
    }
    changedObjects.push(key);
  }
  for (const key of actualByKey.keys()) {
    if (!expectedByKey.has(key)) {
      unexpectedObjects.push(key);
    }
  }

  return {
    missingObjects,
    unexpectedObjects,
    changedObjects,
    missingColumns,
    unexpectedColumns,
  };
}

function objectKey(object: Pick<SchemaObjectManifest, "type" | "name">): string {
  return `${object.type}:${object.name}`;
}

function normalizeType(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeDefault(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  let normalized = value.trim();
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalizeSqlSpacing(lowerOutsideStrings(normalized));
}

function normalizeColumnDefault(
  table: string,
  column: string,
  value: string | null,
): string | null {
  const normalized = normalizeDefault(value);
  if (
    table === "recommendation" &&
    column === "impact_label_checked" &&
    (normalized === "0" || normalized === "1")
  ) {
    return "<v18-compatible-0-or-1>";
  }
  return normalized;
}

function canonicalizeDdl(value: string, objectName: string): string {
  let normalized = transformOutsideStringLiterals(stripSqlComments(value), (segment) =>
    segment
      .replace(/\bIF\s+NOT\s+EXISTS\b/gi, " ")
      .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "$1")
      .replace(/`([A-Za-z_][A-Za-z0-9_]*)`/g, "$1")
      .replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, "$1")
      .toLowerCase(),
  )
    .trim()
    .replace(/;+\s*$/, "");
  normalized = normalizeSqlSpacing(normalized);

  if (!normalized.startsWith("create table ")) {
    return normalized;
  }
  const open = normalized.indexOf("(");
  const close = findMatchingClose(normalized, open);
  if (open < 0 || close < 0) {
    return normalized;
  }
  const prefix = normalized.slice(0, open + 1);
  const body = normalized.slice(open + 1, close);
  const suffix = normalized.slice(close);
  const definitions = splitTopLevel(body).map((definition) =>
    objectName === "recommendation" && definition.startsWith("impact_label_checked ")
      ? transformOutsideStringLiterals(definition, (segment) =>
          segment.replace(/\bdefault [01]\b/, "default <v18-compatible-0-or-1>"),
        )
      : definition,
  );
  return `${prefix}${definitions.sort().join(",")}${suffix}`;
}

function stripSqlComments(value: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    const next = value[index + 1] ?? "";
    if (quote != null) {
      result += char;
      if (char === quote) {
        if (next === quote) {
          result += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      result += char;
      continue;
    }
    if (char === "-" && next === "-") {
      index += 2;
      while (index < value.length && value[index] !== "\n") {
        index += 1;
      }
      result += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < value.length - 1 && !(value[index] === "*" && value[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      result += " ";
      continue;
    }
    result += char;
  }
  return result;
}

function lowerOutsideStrings(value: string): string {
  return transformOutsideStringLiterals(value, (segment) => segment.toLowerCase());
}

function transformOutsideStringLiterals(
  value: string,
  transform: (segment: string) => string,
): string {
  let result = "";
  let outsideStart = 0;
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "'") {
      index += 1;
      continue;
    }
    result += transform(value.slice(outsideStart, index));
    const literalStart = index;
    index += 1;
    while (index < value.length) {
      if (value[index] !== "'") {
        index += 1;
        continue;
      }
      if (value[index + 1] === "'") {
        index += 2;
        continue;
      }
      index += 1;
      break;
    }
    result += value.slice(literalStart, index);
    outsideStart = index;
  }
  return result + transform(value.slice(outsideStart));
}

function normalizeSqlSpacing(value: string): string {
  let result = "";
  let inLiteral = false;
  let pendingSpace = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    const next = value[index + 1] ?? "";
    if (inLiteral) {
      result += char;
      if (char === "'") {
        if (next === "'") {
          result += next;
          index += 1;
        } else {
          inLiteral = false;
        }
      }
      continue;
    }
    if (char === "'") {
      if (pendingSpace && result !== "" && !endsWithSqlPunctuation(result)) {
        result += " ";
      }
      pendingSpace = false;
      inLiteral = true;
      result += char;
      continue;
    }
    if (/\s/.test(char)) {
      pendingSpace = true;
      continue;
    }
    if (char === "(" || char === ")" || char === "," || char === "=") {
      result = result.trimEnd();
      result += char;
      pendingSpace = false;
      continue;
    }
    if (pendingSpace && result !== "" && !endsWithSqlPunctuation(result)) {
      result += " ";
    }
    pendingSpace = false;
    result += char;
  }
  return result.trim();
}

function endsWithSqlPunctuation(value: string): boolean {
  const char = value.at(-1);
  return char === "(" || char === ")" || char === "," || char === "=";
}

function findMatchingClose(value: string, open: number): number {
  if (open < 0) {
    return -1;
  }
  let depth = 0;
  let quote: "'" | null = null;
  for (let index = open; index < value.length; index += 1) {
    const char = value[index] ?? "";
    const next = value[index + 1] ?? "";
    if (quote != null) {
      if (char === quote) {
        if (next === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    const next = value[index + 1] ?? "";
    if (quote != null) {
      if (char === quote) {
        if (next === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function compareForeignKeys(left: SchemaForeignKey, right: SchemaForeignKey): number {
  return (
    compareCodePoints(left.table, right.table) ||
    compareCodePoints(left.from, right.from) ||
    compareNullableStrings(left.to, right.to) ||
    left.sequence - right.sequence ||
    compareCodePoints(left.on_update, right.on_update) ||
    compareCodePoints(left.on_delete, right.on_delete) ||
    compareCodePoints(left.match, right.match)
  );
}

function compareNullableStrings(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left == null) {
    return -1;
  }
  if (right == null) {
    return 1;
  }
  return compareCodePoints(left, right);
}
