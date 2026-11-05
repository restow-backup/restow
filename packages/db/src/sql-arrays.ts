import { type Column, type SQL, sql } from "drizzle-orm";

/**
 * `column = any($1::uuid[])`: membership in a list of ids as ONE bind
 * parameter. drizzle's `inArray` binds one parameter per element, and a
 * statement holds at most 65,535 of them (the wire protocol counts them in an
 * Int16), so a list read from the database (every restore point of a tenant,
 * every object) must never go through `inArray`. An empty list matches nothing.
 */
export function uuidIn(column: Column | SQL, ids: readonly string[]): SQL {
  return sql`${column} = any(${`{${ids.join(",")}}`}::uuid[])`;
}
