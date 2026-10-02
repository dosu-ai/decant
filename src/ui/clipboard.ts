export async function copyTextToClipboard(value: string): Promise<void> {
  let clipboardError: unknown = null;
  if (navigator.clipboard?.writeText != null) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }

  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("aria-hidden", "true");
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw clipboardError instanceof Error
        ? clipboardError
        : new Error("Clipboard access is unavailable.");
    }
  } finally {
    textarea.remove();
    if (returnFocus?.isConnected === true) {
      returnFocus.focus({ preventScroll: true });
    }
  }
}
