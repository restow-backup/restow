import { type SQL, type SQLWrapper, and, eq, gt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { ProblemError } from "../../problem.js";

/**
 * Keyset pagination for the integration API. A cursor names the last row of
 * a page; the next page continues strictly after it, so rows inserted while a
 * client pages never shift the window. Cursors are opaque to clients
 * (base64url JSON) and validated on the way in.
 *
 * Lists that a PSA/RMM mirrors (objects, users) page in insertion order,
 * `(created_at, id)` ascending: entries created during a sync appear at the
 * end instead of being skipped. `created_at` is compared at millisecond
 * precision, the precision a cursor can carry, in the ordering as well as in
 * the filter, so rows within one millisecond are never skipped.
 */

export const createdCursorSchema = z.object({
  at: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});
export type CreatedCursor = z.infer<typeof createdCursorSchema>;

export const idCursorSchema = z.object({ id: z.string().uuid() });
export type IdCursor = z.infer<typeof idCursorSchema>;

export function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function invalidCursor(): ProblemError {
  return new ProblemError(400, "Invalid cursor", {
    type: "urn:restow:problem:invalid-cursor",
    detail: "The cursor is not one this endpoint issued. Start again from the first page.",
  });
}

/** The decoded cursor, null when none was sent; a 400 problem for anything foreign. */
export function decodeCursor<S extends z.ZodTypeAny>(
  schema: S,
  raw: string | undefined,
): z.infer<S> | null {
  if (raw === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw invalidCursor();
  }
  return result.data;
}

/** `created_at` at the precision a cursor carries. */
export function createdAtMs(column: SQLWrapper): SQL {
  return sql`date_trunc('milliseconds', ${column})`;
}

/** Rows strictly after `cursor` in `(created_at, id)` ascending order. */
export function afterCreated(createdAt: SQLWrapper, id: SQLWrapper, cursor: CreatedCursor): SQL {
  const at = new Date(cursor.at);
  const truncated = createdAtMs(createdAt);
  return or(gt(truncated, at), and(eq(truncated, at), gt(id, cursor.id))) as SQL;
}

export interface PageSlice<T> {
  rows: T[];
  next: string | null;
}

/**
 * Turn `limit + 1` fetched rows into a page: the extra row proves there is
 * more, and the last returned row becomes the cursor.
 */
export function slicePage<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (last: T) => Record<string, string>,
): PageSlice<T> {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    next: rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}

/** The cursor fields of a row paged in `(created_at, id)` order. */
export function createdCursorOf(row: { createdAt: Date; id: string }): CreatedCursor {
  return { at: row.createdAt.toISOString(), id: row.id };
}
