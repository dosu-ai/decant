import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { search, searchPage } from "../src/query.ts";
import { SEARCH_MATCH_END, SEARCH_MATCH_START } from "../src/search-query.ts";
import { searchSnippetParts, visuallyOrderedSearchHits } from "../src/ui/search-results.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-ui-search-results-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("search result presentation", () => {
  test("keyboard order follows the visually grouped session order", () => {
    const ranked = [
      { block_id: 11, session_id: 1 },
      { block_id: 21, session_id: 2 },
      { block_id: 12, session_id: 1 },
      { block_id: 31, session_id: 3 },
      { block_id: 22, session_id: 2 },
    ];

    expect(visuallyOrderedSearchHits(ranked).map((hit) => hit.block_id)).toEqual([
      11, 12, 21, 22, 31,
    ]);
  });

  test("highlights only private FTS markers, never ordinary bracketed text", () => {
    const parts = searchSnippetParts(
      `before [ordinary bracketed text] ${SEARCH_MATCH_START}needle${SEARCH_MATCH_END} after`,
    );

    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(["needle"]);
    expect(
      parts
        .filter((part) => !part.match)
        .map((part) => part.text)
        .join(""),
    ).toContain("[ordinary bracketed text]");
  });

  test("query API preserves private markers while CLI search keeps readable brackets", () => {
    const db = openDb(join(workDir, "sentinels.db"));
    try {
      db.exec(`
        INSERT INTO session(id, tool, source_session_id, title, started_at)
        VALUES (1, 'codex', 'sentinel-session', 'Sentinel session', '2026-07-28T00:00:00Z');
        INSERT INTO message(id, session_id, seq, role, timestamp, raw)
        VALUES (1, 1, 0, 'user', '2026-07-28T00:00:00Z', '{}');
        INSERT INTO block(id, message_id, session_id, ordinal, type, text)
        VALUES (
          1, 1, 1, 0, 'text',
          'Keep [ordinary bracketed text] beside sentinelmatch for this test.'
        );
      `);

      const apiSnippet = searchPage(db, "sentinelmatch").results[0]?.snippet ?? "";
      expect(apiSnippet).toContain("[ordinary bracketed text]");
      expect(apiSnippet).toContain(`${SEARCH_MATCH_START}sentinelmatch${SEARCH_MATCH_END}`);

      const cliSnippet = search(db, "sentinelmatch")[0]?.snippet ?? "";
      expect(cliSnippet).toContain("[ordinary bracketed text]");
      expect(cliSnippet).toContain("[sentinelmatch]");
      expect(cliSnippet).not.toContain(SEARCH_MATCH_START);
      expect(cliSnippet).not.toContain(SEARCH_MATCH_END);
    } finally {
      db.close();
    }
  });
});
