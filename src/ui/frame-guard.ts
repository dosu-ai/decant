/** The only window fields the frame guard reads, kept structural so the guard
 * is testable without a DOM. */
export type FrameContext = {
  readonly self: unknown;
  readonly top: unknown;
};

/** True when this document is not the top-level window.
 *
 * The UI can launch a coding agent on this machine, and a click inside a frame
 * reaches the server as a genuinely same-origin request that its Origin check
 * cannot tell apart from a real one. The SPA therefore renders nothing
 * clickable while framed. `top` can be unreadable in exotic embeddings, so a
 * throw is treated as framed and the guard fails closed. */
export function isFramed(view: FrameContext): boolean {
  try {
    return view.top !== view.self;
  } catch {
    return true;
  }
}
