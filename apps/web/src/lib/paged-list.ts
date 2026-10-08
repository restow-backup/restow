/**
 * Lists the API serves newest first in pages (`limit` and `offset`): restores,
 * exports and imports. The page loads as many pages as the person asked for
 * ("Show older"), and says whether more exist instead of silently dropping
 * the oldest entries past the first page.
 */

export interface PagedList<T> {
  items: T[];
  /** The last page loaded was full: older entries may exist. */
  hasMore: boolean;
}

/**
 * Fetch `pages` pages of `pageSize` from offset 0. An entry that moved onto a
 * later page while paging (a new one arrived at the top) is kept once.
 */
export async function fetchPages<T extends { id: string }>(
  fetchPage: (offset: number) => Promise<T[]>,
  pageSize: number,
  pages: number,
): Promise<PagedList<T>> {
  const items: T[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < Math.max(1, pages); page += 1) {
    const batch = await fetchPage(page * pageSize);
    for (const item of batch) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    }
    if (batch.length < pageSize) {
      return { items, hasMore: false };
    }
  }
  return { items, hasMore: true };
}
