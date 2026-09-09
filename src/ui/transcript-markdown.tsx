import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptHighlight } from "./shiki-highlighter.ts";
import {
  markdownLinkBehavior,
  measureTranscriptContent,
  normalizeTranscriptLanguage,
  safeMarkdownUrl,
  type TranscriptLanguage,
  type TranscriptTheme,
} from "./transcript-rendering.ts";

export interface TranscriptMarkdownProps {
  children: string;
  className?: string;
  defaultLanguage?: TranscriptLanguage | null;
}

export interface TranscriptCodeBlockProps {
  code: string;
  deferUntilVisible?: boolean;
  language?: string | null;
}

/**
 * Markdown is parsed to React elements only. HTML and images are disabled:
 * transcript rendering itself must not execute markup or fetch remote assets.
 * Existing special transcript cards should be checked before this component is
 * called; this renderer is the ordinary-text fallback.
 */
export function TranscriptMarkdown({
  children,
  className,
  defaultLanguage = null,
}: TranscriptMarkdownProps) {
  const components = useMemo<Components>(
    () => ({
      a({ children: linkChildren, href }) {
        const behavior = markdownLinkBehavior(href);
        if (behavior.href == null) {
          return <span>{linkChildren}</span>;
        }
        return (
          <a href={behavior.href} rel={behavior.rel} target={behavior.target}>
            {linkChildren}
          </a>
        );
      },
      code({ children: codeChildren, className: codeClassName, ...props }) {
        const value = String(codeChildren);
        const fenceLanguage = codeClassName?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? null;
        const language = normalizeTranscriptLanguage(fenceLanguage) ?? defaultLanguage;
        const block = fenceLanguage != null || value.endsWith("\n");
        if (!block) {
          return (
            <code className={codeClassName} {...props}>
              {codeChildren}
            </code>
          );
        }
        return <TranscriptCodeBlock code={value.replace(/\n$/, "")} language={language} />;
      },
      img() {
        return null;
      },
      pre({ children: preChildren }) {
        return <Fragment>{preChildren}</Fragment>;
      },
    }),
    [defaultLanguage],
  );

  return (
    <div className={className == null ? "transcript-markdown" : className}>
      <Markdown
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url, key) => (key === "src" ? null : (safeMarkdownUrl(url) ?? null))}
      >
        {children}
      </Markdown>
    </div>
  );
}

export function TranscriptCodeBlock({
  code,
  deferUntilVisible = true,
  language,
}: TranscriptCodeBlockProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const visible = useVisible(containerRef, deferUntilVisible);
  const theme = useTranscriptTheme();
  const measure = measureTranscriptContent(code);
  const normalizedLanguage = normalizeTranscriptLanguage(language);
  const [highlight, setHighlight] = useState<TranscriptHighlight | null>(null);

  useEffect(() => {
    let active = true;
    setHighlight(null);
    if (!visible || normalizedLanguage == null || !measure.shouldHighlight) {
      return () => {
        active = false;
      };
    }
    void import("./shiki-highlighter.ts")
      .then(({ highlightTranscriptCode }) =>
        highlightTranscriptCode(code, normalizedLanguage, theme),
      )
      .then((next) => {
        if (active) {
          setHighlight(next);
        }
      })
      .catch(() => {
        // Highlighting is progressive enhancement. A grammar/engine failure
        // leaves the exact plaintext visible instead of breaking the turn.
        if (active) {
          setHighlight(null);
        }
      });
    return () => {
      active = false;
    };
  }, [code, measure.shouldHighlight, normalizedLanguage, theme, visible]);

  return (
    <section
      aria-label={normalizedLanguage == null ? "Code" : `${normalizedLanguage} code`}
      className="transcript-code"
      data-language={normalizedLanguage ?? undefined}
      data-theme={theme}
      ref={containerRef}
    >
      <pre className="transcript-code-pre" style={{ color: highlight?.foreground }}>
        <code className="transcript-code-content">
          {highlight == null
            ? code
            : highlight.tokens.flatMap((line, lineIndex) => [
                ...line.map((token) => (
                  <span key={token.offset} style={tokenStyle(token)}>
                    {token.content}
                  </span>
                )),
                lineIndex < highlight.tokens.length - 1 ? "\n" : null,
              ])}
        </code>
      </pre>
    </section>
  );
}

export function currentTranscriptTheme(): TranscriptTheme {
  if (typeof document === "undefined") {
    return "light";
  }
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "dark" || explicit === "light") {
    return explicit;
  }
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function useTranscriptTheme(): TranscriptTheme {
  const [theme, setTheme] = useState<TranscriptTheme>(currentTranscriptTheme);

  useEffect(() => {
    const update = () => setTheme(currentTranscriptTheme());
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    window.addEventListener("decant:set-theme", update);
    media?.addEventListener("change", update);
    return () => {
      window.removeEventListener("decant:set-theme", update);
      media?.removeEventListener("change", update);
    };
  }, []);

  return theme;
}

function useVisible(ref: { current: HTMLElement | null }, defer: boolean): boolean {
  const [visible, setVisible] = useState(
    () => !defer || typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (!defer) {
      setVisible(true);
      return;
    }
    if (visible) {
      return;
    }
    const element = ref.current;
    if (element == null || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [defer, ref, visible]);

  return visible;
}

function tokenStyle(token: { bgColor?: string; color?: string; fontStyle?: number }): {
  backgroundColor?: string;
  color?: string;
  fontStyle?: "italic";
  fontWeight?: number;
  textDecoration?: "underline";
} {
  const style: {
    backgroundColor?: string;
    color?: string;
    fontStyle?: "italic";
    fontWeight?: number;
    textDecoration?: "underline";
  } = {
    backgroundColor: token.bgColor,
    color: token.color,
  };
  if (((token.fontStyle ?? 0) & 1) !== 0) {
    style.fontStyle = "italic";
  }
  if (((token.fontStyle ?? 0) & 2) !== 0) {
    style.fontWeight = 700;
  }
  if (((token.fontStyle ?? 0) & 4) !== 0) {
    style.textDecoration = "underline";
  }
  return style;
}
