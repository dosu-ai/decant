export type FrameContext = {
  readonly self: unknown;
  readonly top: unknown;
};

export function isFramedOrUnknown(view: FrameContext): boolean {
  try {
    return view.top !== view.self;
  } catch {
    return true;
  }
}
