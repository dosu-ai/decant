/** Private-use markers survive SQLite -> JSON -> React without making ordinary
 * bracketed transcript text look like an FTS match. */
export const SEARCH_MATCH_START = "\uE000";
export const SEARCH_MATCH_END = "\uE001";

/** CLI output remains readable while the API keeps private markers for the UI. */
export function bracketSearchMatches(snippet: string): string {
  return snippet.replaceAll(SEARCH_MATCH_START, "[").replaceAll(SEARCH_MATCH_END, "]");
}

/**
 * Turns plain user input into an FTS5 query without exposing FTS operators.
 *
 * Whitespace-delimited words become exact tokens, quoted input stays a phrase,
 * and only the final token is a prefix query for search-as-you-type behavior.
 * Embedded quotes are escaped with FTS5's doubled-quote syntax.
 */
export function buildFtsQuery(input: string): string {
  const tokens = searchTokens(input.toWellFormed().replaceAll("\u0000", " "));
  if (tokens.length === 0) {
    return '""';
  }
  return tokens
    .map((token, index) => {
      const quoted = `"${token.replaceAll('"', '""')}"`;
      return index === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(" ");
}

function searchTokens(input: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < input.length) {
    while (index < input.length && /\s/u.test(input[index] ?? "")) {
      index += 1;
    }
    if (index >= input.length) {
      break;
    }

    const quoted = input[index] === '"';
    if (quoted) {
      index += 1;
    }
    let token = "";
    while (index < input.length) {
      const character = input[index] ?? "";
      if (character === "\\" && input[index + 1] === '"') {
        token += '"';
        index += 2;
        continue;
      }
      if (quoted && character === '"') {
        index += 1;
        break;
      }
      if (!quoted && /\s/u.test(character)) {
        break;
      }
      token += character;
      index += 1;
    }
    tokens.push(token);
  }

  return tokens;
}
