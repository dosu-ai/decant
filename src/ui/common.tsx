import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { clampNumber } from "./format.ts";
import { Icon } from "./icons.tsx";
import type { BadgeTone, IconName } from "./types.ts";

export function PrivacyReviewLists({
  className,
  excluded,
  excludedLabel,
  included,
  includedLabel,
}: {
  className: string;
  excluded: readonly string[];
  excludedLabel: string;
  included: readonly string[];
  includedLabel: string;
}) {
  return (
    <div className={className}>
      <div>
        <h3>{includedLabel}</h3>
        <ul>
          {included.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <div>
        <h3>{excludedLabel}</h3>
        <ul>
          {excluded.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export type TooltipTriggerProps = {
  ref: (node: HTMLElement | null) => void;
  onBlur: () => void;
  onFocus: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  tabIndex: number;
  "aria-describedby"?: string;
};

export function Tooltip({
  children,
  content,
}: {
  children: (props: TooltipTriggerProps) => ReactNode;
  content: ReactNode;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const openTooltip = () => {
    clearCloseTimer();
    setOpen(true);
  };

  const closeTooltip = () => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => setOpen(false), 80);
  };

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger == null) {
      return;
    }
    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    const width = tooltipRect?.width ?? 320;
    const height = tooltipRect?.height ?? 44;
    const padding = 12;
    const maxLeft = Math.max(padding, window.innerWidth - width - padding);
    const left = clampNumber(
      triggerRect.left + triggerRect.width / 2 - width / 2,
      padding,
      maxLeft,
    );
    let top = triggerRect.top - height - 8;
    if (top < padding) {
      top = triggerRect.bottom + 8;
    }
    top = clampNumber(top, padding, Math.max(padding, window.innerHeight - height - padding));
    setPosition((current) =>
      current != null && current.left === left && current.top === top ? current : { left, top },
    );
  }, []);

  useLayoutEffect(() => {
    if (open) {
      updatePosition();
    }
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    const onScrollOrResize = () => updatePosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (triggerRef.current?.contains(target) === true || tooltipRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, updatePosition]);

  useEffect(
    () => () => {
      clearCloseTimer();
    },
    [clearCloseTimer],
  );

  const triggerProps: TooltipTriggerProps = {
    ref: (node) => {
      triggerRef.current = node;
    },
    onBlur: closeTooltip,
    onFocus: openTooltip,
    onKeyDown: (event) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    },
    onMouseEnter: openTooltip,
    onMouseLeave: closeTooltip,
    tabIndex: 0,
    "aria-describedby": open ? id : undefined,
  };

  return (
    <>
      {children(triggerProps)}
      {open
        ? createPortal(
            <div
              className="floating-tooltip"
              id={id}
              onMouseEnter={openTooltip}
              onMouseLeave={closeTooltip}
              ref={tooltipRef}
              role="tooltip"
              style={
                position == null
                  ? { left: 0, top: 0, visibility: "hidden" }
                  : { left: position.left, top: position.top }
              }
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function Sparkline({ tone = "accent", values }: { tone?: BadgeTone; values: number[] }) {
  const points = sparkPoints(values);
  if (points == null) {
    return <span className="spark-empty">-</span>;
  }
  return (
    <svg
      aria-hidden="true"
      className={`sparkline tone-${tone}`}
      preserveAspectRatio="none"
      viewBox="0 0 100 24"
    >
      <polyline points={points} />
    </svg>
  );
}

export function sparkPoints(values: number[]): string | null {
  const cleanValues = values.map((value) => Math.max(0, value));
  if (cleanValues.length < 2) {
    return null;
  }
  const max = Math.max(1, ...cleanValues);
  return cleanValues
    .map((value, index) => {
      const x = (index / (cleanValues.length - 1)) * 100;
      const y = 23 - (value / max) * 22;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function StatCard({
  alert = false,
  icon,
  label,
  value,
}: {
  /** Danger colour is redundant emphasis on a number that already states the problem; stat icons are otherwise muted by design. */
  alert?: boolean;
  icon: IconName;
  label: string;
  value: string;
}) {
  return (
    <div className="stat-card" data-alert={alert ? "true" : undefined}>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <span className="stat-icon">
        <Icon name={icon} />
      </span>
    </div>
  );
}

export function EmptyState({
  action,
  icon,
  message,
  title,
}: {
  action?: ReactNode;
  icon: IconName;
  message: string;
  title: string;
}) {
  return (
    <div className="empty-state">
      <span>
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      <p>{message}</p>
      {action != null ? <div className="state-actions">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  action,
  detail,
  icon = "info",
  secondaryAction,
  title,
}: {
  action?: ReactNode;
  detail: string;
  icon?: IconName;
  secondaryAction?: ReactNode;
  title: string;
}) {
  return (
    <div className="error-state" role="alert">
      <span>
        <Icon name={icon} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
        {action != null || secondaryAction != null ? (
          <div className="state-actions">
            {action}
            {secondaryAction}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Bar({ fraction, tone }: { fraction: number; tone: BadgeTone }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  return (
    <div className="bar">
      <span className={`tone-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function OverflowMenu({ children, label }: { children: ReactNode; label: string }) {
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  return (
    <details
      className="overflow-menu"
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          event.currentTarget.open = false;
        }
      }}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(".overflow-menu-popover :is(a, button)") != null &&
          menuRef.current != null
        ) {
          menuRef.current.open = false;
          menuRef.current.querySelector("summary")?.focus();
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        if (menuRef.current != null) {
          menuRef.current.open = false;
          menuRef.current.querySelector("summary")?.focus();
        }
      }}
      ref={menuRef}
    >
      <summary aria-label={label} title="More actions">
        <Icon name="ellipsis" />
      </summary>
      <div className="overflow-menu-popover">{children}</div>
    </details>
  );
}
