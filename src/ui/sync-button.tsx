import { Icon } from "./icons.tsx";

export interface SyncButtonProps {
  ariaLabel: string;
  busy: boolean;
  label: string;
  labels?: readonly string[];
  onClick: () => void;
  tone?: "primary" | "secondary";
  update?: boolean;
}

export function SyncButton({
  ariaLabel,
  busy,
  label,
  labels = [label],
  onClick,
  tone = "secondary",
  update = false,
}: SyncButtonProps) {
  return (
    <button
      aria-busy={busy}
      aria-label={ariaLabel}
      className={`${tone}-button sync-button${busy ? " is-syncing" : ""}${update ? " has-update" : ""}`}
      disabled={busy}
      onClick={onClick}
      type="button"
    >
      <Icon name="refresh" />
      <span aria-hidden="true" className="sync-button-label">
        {labels.map((option) => (
          <span data-active={option === label} key={option}>
            {option}
          </span>
        ))}
      </span>
    </button>
  );
}
