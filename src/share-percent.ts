export function sharePercentLabel(part: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) {
    return "-";
  }
  if (!Number.isFinite(part) || part <= 0) {
    return "0.0%";
  }
  const tenths = Math.round((Math.min(part, total) * 1000) / total);
  if (tenths === 0) {
    return "<0.1%";
  }
  if (tenths === 1000 && part < total) {
    return ">99.9%";
  }
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}
