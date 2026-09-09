/** How the Tools summary presents a tool-call error rate.
 *
 * The alert flag is derived from the RENDERED label rather than from the raw
 * rate, so the two cannot disagree. A rate of 0.0004% rounds to "0.0%", and a
 * card reading "0.0%" in the danger colour is a false alarm — the reader sees a
 * red zero and has no way to tell it apart from a real problem.
 */
export interface ErrorRateDisplay {
  /** What the card shows. "—" when nothing has been called yet. */
  label: string;
  /** Whether to render the card in the danger colour. */
  alert: boolean;
}

/** The single formatter. Both the displayed label and the quiet-state
 * comparison run through it, so changing the precision here — or making it
 * locale-aware, where a decimal comma would break a hardcoded "0.0%" — moves
 * both sides together and cannot strand the comparison. */
function formatRate(rate: number): string {
  return `${rate.toFixed(1)}%`;
}

export function errorRateDisplay(totalCalls: number, errorRate: number): ErrorRateDisplay {
  if (totalCalls === 0) {
    return { label: "—", alert: false };
  }
  const label = formatRate(errorRate);
  return { label, alert: label !== formatRate(0) };
}
