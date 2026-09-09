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

/**
 * The index of the control focus should move to, or null when the group has
 * nothing usable left. `enabled[index]` is ignored: the control at `index` is
 * the one that just became disabled.
 */
export function nearestUsableIndex(index: number, enabled: readonly boolean[]): number | null {
  if (index < 0 || index >= enabled.length) {
    return null;
  }
  for (let offset = 1; offset < enabled.length; offset += 1) {
    // Backwards first. A control that disables itself at the end of its work is
    // usually the trailing one in the group, and the control before it is the
    // one the reader would tab back to anyway.
    if (enabled[index - offset] === true) {
      return index - offset;
    }
    if (enabled[index + offset] === true) {
      return index + offset;
    }
  }
  return null;
}
