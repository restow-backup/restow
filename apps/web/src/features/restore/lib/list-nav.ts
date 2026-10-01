/**
 * Keyboard navigation through the item list: pure, so the "which row comes
 * next" logic is unit-tested without a DOM. See explorer/item-list.tsx,
 * which calls this from its `onKeyDown` with only the navigable (non-folder)
 * rows, and whose own DOM test (item-list.test.tsx) covers that folders are
 * skipped and the highlighted row scrolls into view.
 */

export type ListDirection = "up" | "down";

/**
 * The path the reading pane should show after `direction` is pressed, given
 * the list currently on screen and the path shown now (`null` when nothing
 * is open yet). Stops at the first/last row instead of wrapping around, and
 * starting from nothing opens the first row on "down" and the last on "up",
 * so a single key press always lands somewhere useful.
 */
export function moveActivePath(
  entries: readonly { path: string }[],
  activePath: string | null,
  direction: ListDirection,
): string | null {
  if (entries.length === 0) {
    return null;
  }
  const index = activePath === null ? -1 : entries.findIndex((entry) => entry.path === activePath);
  if (index === -1) {
    return direction === "down" ? entries[0].path : entries[entries.length - 1].path;
  }
  const nextIndex = direction === "down" ? index + 1 : index - 1;
  if (nextIndex < 0 || nextIndex >= entries.length) {
    return entries[index].path;
  }
  return entries[nextIndex].path;
}
