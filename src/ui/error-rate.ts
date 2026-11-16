export interface ErrorRateDisplay {
  label: string;
  alert: boolean;
}

function formatRate(rate: number): string {
  return `${rate.toFixed(1)}%`;
}

function roundsToZero(rate: number): boolean {
  return formatRate(rate) === formatRate(0);
}

export function errorRateDisplay(totalCalls: number, errorRate: number): ErrorRateDisplay {
  if (totalCalls === 0) {
    return { label: "—", alert: false };
  }
  return { label: formatRate(errorRate), alert: !roundsToZero(errorRate) };
}
