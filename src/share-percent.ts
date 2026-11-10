/** A count's share of a total to one decimal, rounded on its own. Rows are not
 * forced to sum to 100: doing that showed 1,462 of 2,953 sessions as 49%. A
 * nonzero share never reads 0.0% and a partial one never reads 100.0%. */
export function sharePercentLabel(part: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) {
    return "-";
  }
  if (!Number.isFinite(part) || part <= 0) {
    return "0.0%";
  }
  // Integer tenths keep ties exact: 3 of 2000 is 1.5 tenths, where 0.15.toFixed(1) gives "0.1".
  const tenths = Math.round((Math.min(part, total) * 1000) / total);
  if (tenths === 0) {
    return "<0.1%";
  }
  if (tenths === 1000 && part < total) {
    return ">99.9%";
  }
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}
