import {
  ALL_DATE_RANGE,
  applyDatePreset,
  dateRangeLabel,
  RANGE_PRESETS,
  shiftDateRange,
} from "./date-range.ts";
import { Icon } from "./icons.tsx";
import type { DateBounds, DateRangeSelection } from "./types.ts";

export function DateRangeControl({
  bounds,
  range,
  onChange,
}: {
  bounds: DateBounds | null;
  range: DateRangeSelection;
  onChange: (range: DateRangeSelection) => void;
}) {
  return (
    <div className="date-range-control">
      <div className="date-range-buttons">
        {range.from != null && range.to != null ? (
          <button
            aria-label="Previous period"
            className="icon-period-button"
            onClick={() => onChange(shiftDateRange(range, -1))}
            type="button"
          >
            <Icon name="chevronLeft" />
          </button>
        ) : null}
        <button
          aria-pressed={range.preset === "all"}
          onClick={() => onChange(ALL_DATE_RANGE)}
          type="button"
        >
          All time
        </button>
        {RANGE_PRESETS.map((preset) => (
          <button
            aria-pressed={range.preset === preset.key}
            key={preset.key}
            onClick={() => onChange(applyDatePreset(preset.key, bounds))}
            type="button"
          >
            {preset.label}
          </button>
        ))}
        {range.from != null && range.to != null ? (
          <button
            aria-label="Next period"
            className="icon-period-button"
            onClick={() => onChange(shiftDateRange(range, 1))}
            type="button"
          >
            <Icon name="chevronRight" />
          </button>
        ) : null}
      </div>
      {/* The label spells out a custom range ("Jun 3 to Jun 17"). For "all" it
       * returns "All time", which is now exactly what the selected button reads,
       * so showing it twice just looks like a bug. */}
      {range.preset === "all" ? null : <span>{dateRangeLabel(range)}</span>}
    </div>
  );
}
