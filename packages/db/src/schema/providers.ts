import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

/**
 * The operator of this installation. There is exactly one provider per Restow
 * install; every tenant of the installation belongs to it.
 */
export const providers = pgTable("providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ...timestamps(),
});

export type Provider = typeof providers.$inferSelect;
export type NewProvider = typeof providers.$inferInsert;
