import {
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ALL_DATE_RANGE,
  applyDatePreset,
  checkCustomRange,
  datePopoverAlign,
  dateRangeLabel,
  dateRangePresetLabel,
  RANGE_PRESETS,
  REVERSED_RANGE_MESSAGE,
  refreshTodayRange,
  scheduleUtcDayRollover,
} from "./date-range.ts";
import { Icon } from "./icons.tsx";
import type { DateBounds, DateRangeSelection, RangePreset } from "./types.ts";

// Safari doesn't focus a clicked button, and clicking a field label blurs before
// the label hands focus to its input, so both blur with no relatedTarget.
// Closing on that hid the popover mid-click, which dropped Safari preset
// presses and crashed Chromium on label clicks; outside presses close it instead.
export function focusLeftMenu(menu: Pick<Node, "contains">, next: EventTarget | null): boolean {
  return next != null && "nodeType" in next && !menu.contains(next as Node);
}

/** Keeps a Today selection on the current UTC date in a tab left open past midnight. */
export function useTodayRollover(
  todaySelected: boolean,
  setRange: Dispatch<SetStateAction<DateRangeSelection>>,
) {
  useEffect(() => {
    if (!todaySelected) {
      return;
    }
    const refresh = () => setRange((range) => refreshTodayRange(range));
    // Background tabs throttle timers, so a tab shown again re-checks the date.
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    const stop = scheduleUtcDayRollover(refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [todaySelected, setRange]);
}

// A date input reports a partly typed date as bad input with an empty value.
function dateInputValue(event: ChangeEvent<HTMLInputElement>): string | null {
  return event.target.validity.badInput ? null : event.target.value;
}

export function DateRangeControl({
  bounds,
  range,
  onChange,
}: {
  bounds: DateBounds | null;
  range: DateRangeSelection;
  onChange: (range: DateRangeSelection) => void;
}) {
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  const [align, setAlign] = useState<"start" | "end">("end");
  // Holds From and To only while they don't form a range worth applying, so the
  // inputs show what the user typed while every view keeps the last valid range.
  const [draft, setDraft] = useState<{ from: string | null; to: string | null } | null>(null);
  const errorId = useId();
  const bounded = range.from != null && range.to != null;
  const fields = draft ?? { from: range.from ?? "", to: range.to ?? "" };
  const check = checkCustomRange(fields.from, fields.to);
  const reversed = check.status === "reversed";
  const editCustomRange = (next: { from: string | null; to: string | null }) => {
    const result = checkCustomRange(next.from, next.to);
    if (result.status === "valid") {
      setDraft(null);
      onChange(result.range);
    } else {
      setDraft(next);
    }
  };
  useEffect(() => {
    const closeOnOutsidePress = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false;
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, []);
  const closeMenu = () => {
    if (menuRef.current == null) {
      return;
    }
    menuRef.current.open = false;
    menuRef.current.querySelector("summary")?.focus();
  };

  const choosePreset = (value: Exclude<RangePreset, "custom">) => {
    setDraft(null);
    if (value === "all") {
      onChange(ALL_DATE_RANGE);
      closeMenu();
      return;
    }
    onChange(applyDatePreset(value, bounds));
    closeMenu();
  };

  return (
    <div className="date-range-control">
      <div className="date-range-buttons">
        <details
          className="date-range-menu"
          data-align={align}
          onBlur={(event) => {
            if (focusLeftMenu(event.currentTarget, event.relatedTarget)) {
              event.currentTarget.open = false;
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
          onToggle={(event) => {
            const menu = event.currentTarget;
            const popover = menu.querySelector<HTMLElement>(".date-range-popover");
            if (menu.open && popover != null) {
              setAlign(datePopoverAlign(menu.getBoundingClientRect().right, popover.offsetWidth));
            }
            if (!menu.open) {
              // Reopening shows the applied range, not an abandoned invalid edit.
              setDraft(null);
            }
          }}
          ref={menuRef}
        >
          <summary aria-label={`Time range: ${dateRangePresetLabel(range)}`}>
            <Icon name="clock" />
            <span>{dateRangePresetLabel(range)}</span>
            <Icon name="chevronDown" />
          </summary>
          <div className="date-range-popover">
            <fieldset className="date-range-presets">
              <legend className="sr-only">Time range presets</legend>
              <button
                aria-pressed={range.preset === "all"}
                onClick={() => choosePreset("all")}
                type="button"
              >
                <span>All time</span>
                {range.preset === "all" ? <Icon name="check" /> : null}
              </button>
              {RANGE_PRESETS.map((preset) => (
                <button
                  aria-pressed={range.preset === preset.key}
                  key={preset.key}
                  onClick={() => choosePreset(preset.key)}
                  type="button"
                >
                  <span>{preset.label}</span>
                  {range.preset === preset.key ? <Icon name="check" /> : null}
                </button>
              ))}
            </fieldset>
            <div className="custom-date-range">
              <div className="custom-date-range-heading">
                <span>Custom range</span>
                {range.preset === "custom" && bounded ? (
                  <small>{dateRangeLabel(range)}</small>
                ) : null}
              </div>
              <div className="custom-date-fields">
                <label>
                  <span>From</span>
                  <input
                    aria-describedby={reversed ? errorId : undefined}
                    aria-invalid={
                      reversed || (check.status === "incomplete" && check.field === "from")
                    }
                    aria-label="From date"
                    max={fields.to || undefined}
                    onChange={(event) =>
                      editCustomRange({ ...fields, from: dateInputValue(event) })
                    }
                    type="date"
                    value={fields.from ?? ""}
                  />
                </label>
                <label>
                  <span>To</span>
                  <input
                    aria-describedby={reversed ? errorId : undefined}
                    aria-invalid={
                      reversed || (check.status === "incomplete" && check.field === "to")
                    }
                    aria-label="To date"
                    min={fields.from || undefined}
                    onChange={(event) => editCustomRange({ ...fields, to: dateInputValue(event) })}
                    type="date"
                    value={fields.to ?? ""}
                  />
                </label>
              </div>
              <div aria-live="polite" className="custom-date-range-status">
                {reversed ? (
                  <p className="custom-date-range-error" id={errorId}>
                    {REVERSED_RANGE_MESSAGE}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
