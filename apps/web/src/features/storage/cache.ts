import type { StorageTargetDto, StorageTargetList } from "./types";

/**
 * Pure list updates for the query cache, so a mutation shows its result
 * immediately. The API lists the primary first, then copies by creation.
 */

function byRoleThenCreation(a: StorageTargetDto, b: StorageTargetDto): number {
  if (a.role !== b.role) {
    return a.role === "primary" ? -1 : 1;
  }
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** Insert or replace a target, keeping the API's order. */
export function upsertTarget(list: StorageTargetList, target: StorageTargetDto): StorageTargetList {
  const items = list.items.filter((entry) => entry.id !== target.id);
  items.push(target);
  return { ...list, items: items.sort(byRoleThenCreation) };
}

export function removeTarget(list: StorageTargetList, targetId: string): StorageTargetList {
  return { ...list, items: list.items.filter((entry) => entry.id !== targetId) };
}
