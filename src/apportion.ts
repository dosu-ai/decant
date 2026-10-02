/** Largest-remainder rounding of non-negative values to integers summing to
 * `total`, which must be within one unit per value of their floors' sum. */
export function apportion(values: number[], total: number): number[] {
  const floors = values.map(Math.floor);
  let remaining = total - floors.reduce((sum, value) => sum + value, 0);
  const order = values
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (remaining <= 0) {
      break;
    }
    floors[index] = (floors[index] ?? 0) + 1;
    remaining -= 1;
  }
  return floors;
}
