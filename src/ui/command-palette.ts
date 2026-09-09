export interface CommandPaletteItem {
  id: string;
  label: string;
}

export interface CommandPaletteShortcutInput {
  altKey: boolean;
  ctrlKey: boolean;
  interactiveTarget: boolean;
  key: string;
  metaKey: boolean;
  modalOpen: boolean;
  shiftKey: boolean;
}

export function shouldOpenCommandPalette(input: CommandPaletteShortcutInput): boolean {
  if (input.modalOpen || input.altKey || input.shiftKey) {
    return false;
  }
  const commandK = input.key.toLocaleLowerCase() === "k" && input.metaKey !== input.ctrlKey;
  if (commandK) {
    return true;
  }
  return input.key === "/" && !input.metaKey && !input.ctrlKey && !input.interactiveTarget;
}

export function paletteShortcutLabel(userAgent: string): "⌘K" | "Ctrl K" {
  return /Mac|iPhone|iPad/.test(userAgent) ? "⌘K" : "Ctrl K";
}

export function normalizeRecentSearches(value: unknown, next?: string): string[] {
  const raw = [...(next == null ? [] : [next]), ...(Array.isArray(value) ? value : [])];
  const seen = new Set<string>();
  const searches: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== "string") {
      continue;
    }
    const normalized = candidate.trim().slice(0, 160);
    if (normalized === "" || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    searches.push(normalized);
    if (searches.length === 8) {
      break;
    }
  }
  return searches;
}

export type CommandPaletteGroupId = "recent" | "sessions" | "pages" | "actions" | "content-search";

export interface CommandPaletteGroup<TItem extends CommandPaletteItem = CommandPaletteItem> {
  id: CommandPaletteGroupId;
  label: string | null;
  items: readonly TItem[];
}

export interface CommandPaletteGroupInput<TItem extends CommandPaletteItem = CommandPaletteItem> {
  query: string;
  recent: readonly TItem[];
  sessions: readonly TItem[];
  pages: readonly TItem[];
  actions: readonly TItem[];
  contentSearch: TItem | null;
}

/**
 * Assemble groups in their rendered navigation order. Callers may compute each
 * group's items independently; this function owns empty-group removal and the
 * rule that recent searches appear only before the user starts typing.
 */
export function buildCommandPaletteGroups<TItem extends CommandPaletteItem>(
  input: CommandPaletteGroupInput<TItem>,
): CommandPaletteGroup<TItem>[] {
  const groups: CommandPaletteGroup<TItem>[] = [];
  if (input.query.trim() === "") {
    appendGroup(groups, "recent", "Recent searches", input.recent);
  }
  appendGroup(groups, "sessions", "Sessions", input.sessions);
  appendGroup(groups, "pages", "Pages", input.pages);
  appendGroup(groups, "actions", "Actions", input.actions);
  appendGroup(
    groups,
    "content-search",
    null,
    input.contentSearch == null ? [] : [input.contentSearch],
  );
  return groups;
}

export function flattenCommandPaletteItems<TItem extends CommandPaletteItem>(
  groups: readonly CommandPaletteGroup<TItem>[],
): TItem[] {
  return groups.flatMap((group) => group.items);
}

/**
 * Keep the user's current choice stable when an async session index changes the
 * rendered order. This is especially important for transcript search: rows
 * arriving after the user typed must not silently replace that action with the
 * first session match.
 */
export function reconcileCommandPaletteActiveIndex(
  activeItemId: string | null,
  items: readonly CommandPaletteItem[],
): number | null {
  if (items.length === 0) {
    return null;
  }
  if (activeItemId != null) {
    const preservedIndex = items.findIndex((item) => item.id === activeItemId);
    if (preservedIndex >= 0) {
      return preservedIndex;
    }
  }
  return 0;
}

export interface PointerMovement {
  movementX: number;
  movementY: number;
}

/**
 * Programmatic scrollIntoView calls can move an option underneath a stationary
 * pointer. Only real pointer movement may replace a keyboard selection.
 */
export function pointerMovementChangesSelection(event: PointerMovement): boolean {
  return event.movementX !== 0 || event.movementY !== 0;
}

export interface CommandPaletteKeyState {
  activeIndex: number | null;
}

export interface CommandPaletteKeyInput {
  key: string;
  itemCount: number;
  isComposing?: boolean;
}

export type CommandPaletteKeyEffect = "none" | "activate" | "close";

export interface CommandPaletteKeyResult extends CommandPaletteKeyState {
  effect: CommandPaletteKeyEffect;
  handled: boolean;
}

/**
 * Keyboard state transition over the flattened rendered item list. Arrow keys
 * wrap so moving between visual groups has the same behavior as moving within
 * one group; Enter and Escape are returned as effects for the React layer.
 */
export function reduceCommandPaletteKey(
  state: CommandPaletteKeyState,
  input: CommandPaletteKeyInput,
): CommandPaletteKeyResult {
  const itemCount = normalizeItemCount(input.itemCount);
  const activeIndex = normalizeActiveIndex(state.activeIndex, itemCount);
  if (input.isComposing === true) {
    return idle(activeIndex);
  }

  switch (input.key) {
    case "ArrowDown":
      if (itemCount === 0) {
        return idle(null);
      }
      return moved(activeIndex == null ? 0 : (activeIndex + 1) % itemCount);
    case "ArrowUp":
      if (itemCount === 0) {
        return idle(null);
      }
      return moved(activeIndex == null ? itemCount - 1 : (activeIndex - 1 + itemCount) % itemCount);
    case "Home":
      return itemCount === 0 ? idle(null) : moved(0);
    case "End":
      return itemCount === 0 ? idle(null) : moved(itemCount - 1);
    case "Enter":
      return activeIndex == null ? idle(null) : { activeIndex, effect: "activate", handled: true };
    case "Escape":
      return { activeIndex, effect: "close", handled: true };
    default:
      return idle(activeIndex);
  }
}

function appendGroup<TItem extends CommandPaletteItem>(
  groups: CommandPaletteGroup<TItem>[],
  id: CommandPaletteGroupId,
  label: string | null,
  items: readonly TItem[],
): void {
  if (items.length > 0) {
    groups.push({ id, label, items: [...items] });
  }
}

function normalizeItemCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function normalizeActiveIndex(value: number | null, itemCount: number): number | null {
  return value != null && Number.isSafeInteger(value) && value >= 0 && value < itemCount
    ? value
    : null;
}

function moved(activeIndex: number): CommandPaletteKeyResult {
  return { activeIndex, effect: "none", handled: true };
}

function idle(activeIndex: number | null): CommandPaletteKeyResult {
  return { activeIndex, effect: "none", handled: false };
}
