/** A count's share of a total to one decimal, rounded on its own. Rows are not
 * forced to sum to 100: doing that showed 1,462 of 2,953 sessions as 49%. A
 * nonzero share never reads 0.0% and a partial one never reads 100.0%. */
export function sharePercentLabel(part: number, total: number): string {
  if (!(total > 0) || !(part > 0)) {
    return "0.0%";
  }
  const percent = (part / total) * 100;
  if (percent < 0.05) {
    return "<0.1%";
  }
  if (percent >= 99.95 && part < total) {
    return ">99.9%";
  }
  return `${percent.toFixed(1)}%`;
}
