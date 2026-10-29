import { useRef } from "react";
import {
  ALL_DATE_RANGE,
  applyDatePreset,
  dateRangeLabel,
  dateRangePresetLabel,
  RANGE_PRESETS,
} from "./date-range.ts";
import { Icon } from "./icons.tsx";
import type { DateBounds, DateRangeSelection, RangePreset } from "./types.ts";

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
  const bounded = range.from != null && range.to != null;
  const closeMenu = () => {
    if (menuRef.current == null) {
      return;
    }
    menuRef.current.open = false;
    menuRef.current.querySelector("summary")?.focus();
  };

  const choosePreset = (value: Exclude<RangePreset, "custom">) => {
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
          onBlur={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            ) {
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
                    aria-label="From date"
                    max={range.to ?? undefined}
                    onChange={(event) =>
                      onChange({ ...range, from: event.target.value || null, preset: "custom" })
                    }
                    type="date"
                    value={range.from ?? ""}
                  />
                </label>
                <label>
                  <span>To</span>
                  <input
                    aria-label="To date"
                    min={range.from ?? undefined}
                    onChange={(event) =>
                      onChange({ ...range, preset: "custom", to: event.target.value || null })
                    }
                    type="date"
                    value={range.to ?? ""}
                  />
                </label>
              </div>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
