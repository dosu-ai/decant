import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { INGEST_ISSUE_CODES } from "../src/model.ts";
import { buildFtsQuery } from "../src/search-query.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";

// Property-based coverage for the parser totality invariant (AGENTS.md:
// core modules return data and Result-style errors): arbitrary bytes on
// disk must never make a parser throw, malformed JSONL lines must be
// reported exactly as unparsed_line issues without derailing neighboring
// lines, and every issue must obey the typed-diagnostics contract in
// src/model.ts (known code, in-bounds lineNo, rawLine only on
// unparsed_line).

const jsonLine = fc.json({ maxDepth: 3, stringUnit: "binary" });
const blankLine = fc.constantFrom("", " ", "\t", " \t ");
// A complete JSON value with a trailing brace is always a syntax error,
// never blank, and never spans lines.
const brokenLine = jsonLine.map((line) => `${line}}`);

interface TaggedLine {
  line: string;
  broken: boolean;
}

const taggedLines = fc.array(
  fc.oneof(
    jsonLine.map((line): TaggedLine => ({ line, broken: false })),
    blankLine.map((line): TaggedLine => ({ line, broken: false })),
    brokenLine.map((line): TaggedLine => ({ line, broken: true })),
  ),
  { maxLength: 30 },
);

const arbitraryContent = fc.oneof(
  fc.string({ unit: "binary", maxLength: 2000 }),
  fc
    .array(fc.string({ unit: "binary", maxLength: 200 }), { maxLength: 20 })
    .map((lines) => lines.join("\n")),
);

const parsers = [
  {
    name: "parseClaudeSession",
    tool: "claude_code",
    parse: (content: string) => parseClaudeSession("prop-session", content),
  },
  {
    name: "parseCodexSession",
    tool: "codex",
    parse: (content: string) => parseCodexSession("prop-session", content, new Map()),
  },
] as const;

const searchDb = new Database(":memory:");
searchDb.exec(`
  CREATE VIRTUAL TABLE search_property_fts USING fts5(text, prefix='2 3');
  INSERT INTO search_property_fts(text) VALUES ('auth token flow'), ('quoted words');
`);
afterAll(() => searchDb.close());

describe("buildFtsQuery", () => {
  test("quotes words, preserves phrases, escapes quotes, and prefixes only the final token", () => {
    expect(buildFtsQuery("auth token")).toBe('"auth" "token"*');
    expect(buildFtsQuery('auth "token flow"')).toBe('"auth" "token flow"*');
    expect(buildFtsQuery('"say \\"hello\\"" next')).toBe('"say ""hello""" "next"*');
    expect(buildFtsQuery('"unfinished phrase')).toBe('"unfinished phrase"*');
    expect(buildFtsQuery('auth"token')).toBe('"auth""token"*');
  });

  test("always produces an FTS5-safe query for arbitrary user input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (input) => {
        const query = buildFtsQuery(input);
        expect(() =>
          searchDb
            .query("SELECT rowid FROM search_property_fts WHERE search_property_fts MATCH ?")
            .all(query),
        ).not.toThrow();
      }),
    );
  });

  test("repairs lone UTF-16 surrogates before quoting", () => {
    for (const input of ["a\uD800:b", "a\uDFFF:b", "\uD800", "\uDFFF"]) {
      const query = buildFtsQuery(input);
      expect(() =>
        searchDb
          .query("SELECT rowid FROM search_property_fts WHERE search_property_fts MATCH ?")
          .all(query),
      ).not.toThrow();
      expect(query).not.toMatch(/[\uD800-\uDFFF]/u);
    }
  });
});

for (const { name, tool, parse } of parsers) {
  describe(name, () => {
    test("never throws and returns a well-formed session for arbitrary content", () => {
      fc.assert(
        fc.property(arbitraryContent, (content) => {
          const parsed = parse(content);
          const lineCount = content.split(/\n/).length;
          expect(parsed.session.tool).toBe(tool);
          expect(Array.isArray(parsed.session.messages)).toBe(true);
          for (const issue of parsed.issues) {
            expect(INGEST_ISSUE_CODES).toContain(issue.code);
            expect(issue.error).not.toBe("");
            if (issue.lineNo != null) {
              expect(issue.lineNo).toBeGreaterThanOrEqual(1);
              expect(issue.lineNo).toBeLessThanOrEqual(lineCount);
            }
            if (issue.code !== "unparsed_line") {
              expect(issue.rawLine).toBeNull();
            }
          }
        }),
      );
    });

    test("parses the same content to the same result", () => {
      fc.assert(
        fc.property(arbitraryContent, (content) => {
          expect(parse(content)).toEqual(parse(content));
        }),
      );
    });

    test("flags exactly the malformed lines as unparsed", () => {
      fc.assert(
        fc.property(taggedLines, (lines) => {
          const { issues } = parse(lines.map((tagged) => tagged.line).join("\n"));
          const unparsed = issues.filter((issue) => issue.code === "unparsed_line");
          const expected = lines.flatMap((tagged, index) => (tagged.broken ? [index + 1] : []));
          expect(unparsed.map((issue) => issue.lineNo)).toEqual(expected);
          for (const issue of unparsed) {
            expect(issue.error).not.toBe("");
            expect(issue.rawLine).toBe(lines[(issue.lineNo ?? 0) - 1]?.line ?? "");
          }
        }),
      );
    });

    test("valid json lines and blank lines never become unparsed-line issues", () => {
      fc.assert(
        fc.property(fc.array(fc.oneof(jsonLine, blankLine), { maxLength: 30 }), (lines) => {
          const { issues } = parse(lines.join("\n"));
          expect(issues.filter((issue) => issue.code === "unparsed_line")).toEqual([]);
        }),
      );
    });

    test("numbers messages sequentially from zero", () => {
      fc.assert(
        fc.property(arbitraryContent, (content) => {
          const { session } = parse(content);
          for (const [index, message] of session.messages.entries()) {
            expect(message.seq).toBe(index);
          }
        }),
      );
    });
  });
}
