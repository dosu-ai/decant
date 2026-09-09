import type { ThemedToken, TokensResult } from "shiki/core";
import { createBundledHighlighter, createSingletonShorthands } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import {
  measureTranscriptContent,
  normalizeTranscriptLanguage,
  type TranscriptLanguage,
  type TranscriptTheme,
} from "./transcript-rendering.ts";

export type TranscriptHighlightToken = Pick<
  ThemedToken,
  "bgColor" | "color" | "content" | "fontStyle" | "offset"
>;

export interface TranscriptHighlight {
  background: string | undefined;
  foreground: string | undefined;
  language: TranscriptLanguage;
  theme: TranscriptTheme;
  tokens: TranscriptHighlightToken[][];
}

/**
 * These are deliberately the only grammars and themes reachable from the UI
 * bundle. Do not replace this with `shiki`, `shiki/bundle/web`, or
 * `langs-precompiled`: the former include broad registries and the latter is
 * currently called out as unsafe for many grammars by Shiki upstream.
 */
const bundledLanguages = {
  bash: () => import("@shikijs/langs/bash"),
  diff: () => import("@shikijs/langs/diff"),
  go: () => import("@shikijs/langs/go"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  markdown: () => import("@shikijs/langs/markdown"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  sql: () => import("@shikijs/langs/sql"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  yaml: () => import("@shikijs/langs/yaml"),
};

const bundledThemes = {
  "github-dark": () => import("@shikijs/themes/github-dark"),
  "github-light": () => import("@shikijs/themes/github-light"),
};

const createTranscriptHighlighter = createBundledHighlighter({
  engine: () => createJavaScriptRegexEngine(),
  langs: bundledLanguages,
  themes: bundledThemes,
});

const { codeToTokens, getSingletonHighlighter } = createSingletonShorthands(
  createTranscriptHighlighter,
);

export async function highlightTranscriptCode(
  code: string,
  requestedLanguage: string | null | undefined,
  theme: TranscriptTheme,
): Promise<TranscriptHighlight | null> {
  const language = normalizeTranscriptLanguage(requestedLanguage);
  if (language == null || !measureTranscriptContent(code).shouldHighlight) {
    return null;
  }
  const themeName = theme === "dark" ? "github-dark" : "github-light";
  const result: TokensResult = await codeToTokens(code, {
    lang: language,
    theme: themeName,
    tokenizeMaxLineLength: 20_000,
    tokenizeTimeLimit: 100,
  });
  return {
    background: result.bg,
    foreground: result.fg,
    language,
    theme,
    tokens: result.tokens.map((line) =>
      line.map(({ bgColor, color, content, fontStyle, offset }) => ({
        bgColor,
        color,
        content,
        fontStyle,
        offset,
      })),
    ),
  };
}

/** Test/diagnostic seam proving every call shares one lazy highlighter. */
export async function transcriptHighlighterIdentity(): Promise<object> {
  return await getSingletonHighlighter();
}
