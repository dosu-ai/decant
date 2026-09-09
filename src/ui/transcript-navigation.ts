export type TranscriptNavigationDirection = -1 | 1;

export interface TranscriptNavigationKey {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export function transcriptNavigationDirection(
  event: TranscriptNavigationKey,
): TranscriptNavigationDirection | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (event.key === "ArrowDown") {
    return 1;
  }
  if (event.key === "ArrowUp") {
    return -1;
  }
  return null;
}

export function nextTranscriptSeq(
  sequences: readonly number[],
  activeSeq: number | null,
  direction: TranscriptNavigationDirection,
): number | null {
  if (sequences.length === 0) {
    return null;
  }
  if (activeSeq == null) {
    return direction === 1 ? (sequences[0] ?? null) : (sequences.at(-1) ?? null);
  }
  const activeIndex = sequences.indexOf(activeSeq);
  if (activeIndex === -1) {
    return direction === 1 ? (sequences[0] ?? null) : (sequences.at(-1) ?? null);
  }
  return sequences[activeIndex + direction] ?? null;
}

const INTERACTIVE_SELECTOR =
  "a, button, summary, input, textarea, select, [contenteditable='true'], [role='button'], [role='link'], [role='slider'], [role='tab']";

/**
 * The part of a DOM node this guard actually reads. Matched structurally rather
 * than with `instanceof HTMLElement`, because focusable nodes outside the HTML
 * namespace need guarding too: the compaction markers in the context-window
 * strip are `<a>` elements inside the `<svg>`, so they are `SVGAElement` --
 * tabbable, focusable, and carrying no `isContentEditable`.
 */
export interface TranscriptEventTarget {
  isContentEditable?: boolean;
  matches(selectors: string): boolean;
  closest(selectors: string): unknown;
}

/**
 * True when a keyboard event landed on something the page already handles, so
 * transcript navigation should stand down instead of stealing the key.
 */
export function isInteractiveTarget(target: unknown): boolean {
  if (target == null || typeof target !== "object") {
    return false;
  }
  const candidate = target as Partial<TranscriptEventTarget>;
  if (typeof candidate.matches !== "function" || typeof candidate.closest !== "function") {
    return false;
  }
  if (candidate.isContentEditable === true) {
    return true;
  }
  return (
    candidate.matches("input, textarea, select") || candidate.closest(INTERACTIVE_SELECTOR) != null
  );
}

/**
 * The part of a turn element `revealTranscriptMessage` drives. Structural for
 * the same reason as `TranscriptEventTarget`, and so tests need no real DOM.
 */
export interface TranscriptScrollTarget {
  scrollIntoView(options: { behavior: "auto" | "smooth"; block: "start" }): void;
  focus(options: { preventScroll: boolean }): void;
}

/**
 * Bring a turn into view and move focus to it. Focus is the point: without it
 * arrow-key navigation is a purely visual highlight that assistive tech never
 * announces. `preventScroll` keeps the browser from running a second, competing
 * scroll to an element we just animated to.
 *
 * Returns false when there is nothing to reveal, which happens whenever the
 * target seq sits outside the currently loaded message window.
 */
export function revealTranscriptMessage(
  target: TranscriptScrollTarget | null | undefined,
  prefersReducedMotion: boolean,
): boolean {
  if (target == null) {
    return false;
  }
  target.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
  return true;
}

/**
 * Selector for anything modal enough that arrow keys should not reach the
 * transcript underneath it. The command palette and detail dialogs match this
 * guard so they cannot silently scroll the page behind themselves.
 *
 * `[role='dialog']` alone missed both of the other ways a modal is normally
 * expressed, so all three are covered: the native element (only while open,
 * since a closed `<dialog>` stays in the DOM), the ARIA role, and the
 * `aria-modal` flag.
 */
const MODAL_SELECTOR = "dialog[open], [role='dialog'], [role='alertdialog'], [aria-modal='true']";

/** True when a modal is on screen, so transcript navigation should stand down. */
export function hasOpenModal(root: { querySelector(selectors: string): unknown } | null): boolean {
  return root?.querySelector(MODAL_SELECTOR) != null;
}

export function transcriptSeqFromHash(hash: string): number | null {
  const match = hash.match(/^#message-(\d+)$/);
  if (match == null) {
    return null;
  }
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}
