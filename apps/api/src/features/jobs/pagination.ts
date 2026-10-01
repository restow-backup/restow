/**
 * Keyset pagination for job lists, newest first. The cursor names the last
 * row of a page by `(created_at, id)`; the next page continues strictly after
 * it, so a job inserted while the client pages never shifts the window. The
 * cursor is opaque to clients (base64url JSON) and validated on the way in.
 */

export interface JobPageCursor {
  /** ISO-8601 `created_at` of the last row on the previous page. */
  readonly createdAt: string;
  /** `id` of that row, the tie-breaker for equal timestamps. */
  readonly id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: JobPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** The cursor, or null for anything that is not one of ours. */
export function decodeCursor(value: string | undefined): JobPageCursor | null {
  if (!value) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const { createdAt, id } = parsed as { createdAt?: unknown; id?: unknown };
  if (typeof createdAt !== "string" || typeof id !== "string" || !UUID.test(id)) {
    return null;
  }
  if (Number.isNaN(Date.parse(createdAt))) {
    return null;
  }
  return { createdAt, id };
}

export interface Page<T> {
  readonly items: T[];
  /** Cursor of the next page, or null on the last page. */
  readonly next: string | null;
}

/**
 * Turn `limit + 1` rows into a page: the extra row proves there is more and
 * the last returned row becomes the cursor.
 */
export function pageOf<T extends { readonly id: string; readonly createdAt: Date }>(
  rows: readonly T[],
  limit: number,
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const hasMore = rows.length > limit && last !== undefined;
  return {
    items,
    next: hasMore ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  };
}
