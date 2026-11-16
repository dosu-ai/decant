/**
 * Where keyboard focus lands when the control holding it disables itself.
 *
 * Buttons across the UI disable on click while their work runs or once it makes
 * them redundant: Sync while a sync is in flight, Next once the last page
 * arrives. Browsers unfocus an element the instant it becomes disabled, so a
 * pointer user notices nothing while a keyboard user is dropped to the document
 * body, losing their place. Handing focus to the nearest still-usable control in
 * the same group keeps the reader where they were working.
 */

export function nearestUsableIndex(index: number, enabled: readonly boolean[]): number | null {
  if (index < 0 || index >= enabled.length) {
    return null;
  }
  for (let offset = 1; offset < enabled.length; offset += 1) {
    if (enabled[index - offset] === true) {
      return index - offset;
    }
    if (enabled[index + offset] === true) {
      return index + offset;
    }
  }
  return null;
}
