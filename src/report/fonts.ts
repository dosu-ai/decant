import { readFileSync } from "node:fs";
import plexMonoRegularPath from "./fonts/IBMPlexMono-Regular-Latin1.woff2" with { type: "file" };
import plexSansRegularPath from "./fonts/IBMPlexSans-Regular-Latin1.woff2" with { type: "file" };
import plexSansSemiboldPath from "./fonts/IBMPlexSans-SemiBold-Latin1.woff2" with { type: "file" };
import sourceSerifSemiboldPath from "./fonts/SourceSerif4-Semibold.woff2" with { type: "file" };

function fontData(path: string): string {
  return readFileSync(path).toString("base64");
}

let cachedFontCss: string | undefined;

/** Trusted, bundled font declarations for static report documents. */
export function reportFontCss(): string {
  cachedFontCss ??= buildFontCss();
  return cachedFontCss;
}

function buildFontCss(): string {
  return `
@font-face {
  font-family: "IBM Plex Sans";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("data:font/woff2;base64,${fontData(plexSansRegularPath)}") format("woff2");
}
@font-face {
  font-family: "IBM Plex Sans";
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url("data:font/woff2;base64,${fontData(plexSansSemiboldPath)}") format("woff2");
}
@font-face {
  font-family: "IBM Plex Mono";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("data:font/woff2;base64,${fontData(plexMonoRegularPath)}") format("woff2");
}
@font-face {
  font-family: "Source Serif 4";
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url("data:font/woff2;base64,${fontData(sourceSerifSemiboldPath)}") format("woff2");
}
`;
}
