export interface ErrorRateDisplay {
  label: string;
  alert: boolean;
}

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
