import type { SourceDto } from "./types";

/**
 * Pure list updates for the query cache, so a mutation shows its result
 * immediately without a refetch. The API lists sources ordered by name.
 */

function byName(a: SourceDto, b: SourceDto): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Insert or replace a source, keeping the name order. */
export function upsertSource(list: readonly SourceDto[], source: SourceDto): SourceDto[] {
  const next = list.filter((entry) => entry.id !== source.id);
  next.push(source);
  return next.sort(byName);
}

export function removeSource(list: readonly SourceDto[], sourceId: string): SourceDto[] {
  return list.filter((entry) => entry.id !== sourceId);
}
