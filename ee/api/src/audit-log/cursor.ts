/**
 * Keyset pagination for the audit log, newest first. The cursor names the
 * last entry of a page by `(created_at, id)`; the next page continues
 * strictly after it, so entries appended while a client pages never shift
 * the window. Clients treat it as opaque (base64url JSON); it is validated on
 * the way back in.
 */

export interface AuditCursor {
  /** ISO-8601 `created_at` of the last entry on the previous page. */
  readonly createdAt: string;
  /** `id` of that entry, the tie-breaker for equal timestamps. */
  readonly id: string;
}

export interface Page<T> {
  readonly items: T[];
  /** Cursor of the next page, or null on the last page. */
  readonly next: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** The cursor, or null for anything that is not one of ours. */
export function decodeAuditCursor(value: string): AuditCursor | null {
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

/**
 * Turn `limit + 1` rows into a page: the extra row proves there is more, and
 * the last returned row becomes the cursor.
 */
export function pageOf<T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => { id: string; createdAt: Date },
): { rows: T[]; next: string | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  if (rows.length <= limit || last === undefined) {
    return { rows: page, next: null };
  }
  const key = keyOf(last);
  return {
    rows: page,
    next: encodeAuditCursor({ createdAt: key.createdAt.toISOString(), id: key.id }),
  };
}
