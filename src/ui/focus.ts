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

export function useBackdropDismiss(
  open: boolean,
  backdropRef: { current: HTMLElement | null },
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onMouseDown = (event: MouseEvent) => {
      if (backdropRef.current != null && event.target === backdropRef.current) {
        onDismiss();
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [backdropRef, onDismiss, open]);
}

export function useDisabledFocusRescue() {
  useEffect(() => {
    let lastFocused: HTMLElement | null = null;
    let pendingRescue: WeakRef<HTMLElement> | null = null;
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
      retryPending();
    });
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
