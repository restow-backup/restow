/**
 * `items.map(fn)` with at most `limit` calls running at a time, the results in the order of
 * `items`. For work that holds a connection of a pool per call: a few at a time are faster than
 * one after the other, and leave the rest of the pool to the requests that come meanwhile.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}
