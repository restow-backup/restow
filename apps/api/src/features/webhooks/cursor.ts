import { isUuid } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";

/**
 * Opaque cursor of the delivery log (newest first). It carries the last
 * row's `created_at` at full microsecond precision (as Postgres prints it)
 * and its id as the tie-breaker, so paging never skips or repeats a row.
 */

export interface DeliveryCursor {
  createdAt: string;
  id: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function encodeDeliveryCursor(cursor: DeliveryCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), "utf8").toString("base64url");
}

function invalidCursor(): ProblemError {
  return new ProblemError(400, "Invalid cursor", {
    detail: "The cursor is malformed. Start again without one.",
  });
}

export function decodeDeliveryCursor(value: string): DeliveryCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw invalidCursor();
  }
  const [createdAt, id] = parsed as unknown[];
  if (typeof createdAt !== "string" || !TIMESTAMP.test(createdAt)) {
    throw invalidCursor();
  }
  if (typeof id !== "string" || !isUuid(id)) {
    throw invalidCursor();
  }
  return { createdAt, id };
}
