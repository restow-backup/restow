/**
 * The text of a JSON value with its keys in order. The database keeps an object's keys in its own
 * order (jsonb), a client sends them in its own: two documents are the same when they say the
 * same, whatever order they were written in.
 */
export function canonicalJson(value: unknown): string {
  const ordered = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(ordered);
    }
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return node;
  };
  return JSON.stringify(ordered(value ?? null));
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
