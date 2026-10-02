import { tenants } from "@restow/db";
import { asc, desc, sql } from "drizzle-orm";

/**
 * The order of every tenant list the web shows (the profile's tenants and the
 * provider's tenant list): the operator's own organisation first, then the
 * customers by name. The own organisation is compared by value, not by the
 * enum's position, so the order does not depend on how the kinds are declared.
 */
export const internalFirstByName = [
  desc(sql`${tenants.kind} = 'internal'`),
  asc(tenants.name),
] as const;
