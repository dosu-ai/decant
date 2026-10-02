import { useEffect } from "react";
import { nearestUsableIndex } from "./focus-rescue.ts";

export const FOCUS_CANDIDATE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function dialogFocusTargets(dialog: HTMLElement | null): HTMLElement[] {
  if (dialog == null) {
    return [];
  }
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUS_CANDIDATE_SELECTOR)).filter(
    (element) => !element.matches(":disabled") && element.getClientRects().length > 0,
  );
}

export function useDialogFocusTrap(
  open: boolean,
  dialogRef: { current: HTMLElement | null },
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      (dialogFocusTargets(dialog)[0] ?? dialog)?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const dialog = dialogRef.current;
      const focusTargets = dialogFocusTargets(dialog);
      const first = focusTargets[0];
      const last = focusTargets.at(-1);
      if (dialog == null) {
        return;
      }
      if (first == null || last == null) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      if (returnFocus?.isConnected === true) {
        returnFocus.focus();
      }
    };
  }, [dialogRef, onClose, open]);
}

/**
 * One rescue for every button that disables itself while focused. React writes
 * `disabled` as an attribute, so a single observer sees all of them and the fix
 * does not have to be repeated at each `disabled={...ing}` call site.
 */
export function useDisabledFocusRescue() {
  useEffect(() => {
    let lastFocused: HTMLElement | null = null;
    let pendingRescue: WeakRef<HTMLElement> | null = null;
    // A busy control may come back, while a redundant control (for example,
    // Next on the last page) may never re-enable. Keep both elements weak so a
    // pending restore cannot retain a detached subtree for the life of the app.
    let pendingRestore: {
      control: WeakRef<HTMLElement>;
      landed: WeakRef<HTMLElement>;
    } | null = null;
    const remember = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      pendingRescue = null;
      if (pendingRestore?.landed.deref() !== target) {
        pendingRestore = null;
      }
      lastFocused = target;
    };
    const focusNeedsRescue = (control: HTMLElement) => {
      const landed = document.activeElement;
      return (
        landed === null ||
        (landed === control && control.matches(":disabled")) ||
        landed === document.body ||
        landed === document.documentElement
      );
    };
    const rescueTarget = (control: HTMLElement) => {
      // Landing outside the region the reader was working in, or outside an open
      // dialog, is more disorienting than leaving focus where it fell.
      const boundary = control.closest('dialog, [role="dialog"], main, nav, form');
      for (let scope = control.parentElement; scope != null; scope = scope.parentElement) {
        const candidates = Array.from(
          scope.querySelectorAll<HTMLElement>(FOCUS_CANDIDATE_SELECTOR),
        ).filter((element) => element === control || element.getClientRects().length > 0);
        const enabled = candidates.map((element) => !element.matches(":disabled"));
        const next = candidates[nearestUsableIndex(candidates.indexOf(control), enabled) ?? -1];
        if (next != null) {
          return next;
        }
        if (scope === boundary) {
          return null;
        }
      }
      return null;
    };
    const retryPending = () => {
      const control = pendingRescue?.deref();
      if (control == null || !control.isConnected || !focusNeedsRescue(control)) {
        pendingRescue = null;
        return;
      }
      // If the original control re-enabled before the rest of its group offered
      // a safe landing place, it is itself the least surprising destination.
      if (!control.matches(":disabled")) {
        pendingRescue = null;
        control.focus();
        return;
      }
      const next = rescueTarget(control);
      if (next != null) {
        // Set this before focus(): focusin fires synchronously and must recognize
        // the landing as ours rather than treating it as reader navigation.
        pendingRestore = {
          control: new WeakRef(control),
          landed: new WeakRef(next),
        };
        next.focus();
        if (document.activeElement !== next) {
          pendingRestore = null;
        }
      }
    };
    const observer = new MutationObserver((records) => {
      const restoreControl = pendingRestore?.control.deref();
      const restoreLanding = pendingRestore?.landed.deref();
      if (
        restoreControl == null ||
        restoreLanding == null ||
        !restoreControl.isConnected ||
        !restoreLanding.isConnected ||
        document.activeElement !== restoreLanding
      ) {
        pendingRestore = null;
      } else if (!restoreControl.matches(":disabled")) {
        pendingRestore = null;
        restoreControl.focus();
      }

      for (const record of records) {
        const control = record.target;
        if (
          control !== lastFocused ||
          !(control instanceof HTMLElement) ||
          !control.matches(":disabled") ||
          !focusNeedsRescue(control)
        ) {
          continue;
        }
        lastFocused = null;
        pendingRescue = new WeakRef(control);
        break;
      }
      // A pagination group can remain entirely disabled for longer than any
      // safe timer. Every relevant control becoming usable changes its disabled
      // attribute, so retry from that mutation instead of racing the request.
      retryPending();
    });
    // Focus leaving a control that is still enabled means the reader moved on,
    // so a later disable on that control is not ours to rescue.
    const forget = (event: FocusEvent) => {
      if (
        event.target === lastFocused &&
        event.target instanceof HTMLElement &&
        !event.target.matches(":disabled")
      ) {
        lastFocused = null;
      }
    };
    const cancelPending = () => {
      pendingRescue = null;
      pendingRestore = null;
    };
    document.addEventListener("focusin", remember);
    document.addEventListener("focusout", forget);
    document.addEventListener("keydown", cancelPending, true);
    document.addEventListener("pointerdown", cancelPending, true);
    observer.observe(document.body, {
      attributeFilter: ["disabled"],
      attributes: true,
      subtree: true,
    });
    return () => {
      document.removeEventListener("focusin", remember);
      document.removeEventListener("focusout", forget);
      document.removeEventListener("keydown", cancelPending, true);
      document.removeEventListener("pointerdown", cancelPending, true);
      observer.disconnect();
    };
  }, []);
}
