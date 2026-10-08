import { type SQL, sql } from "drizzle-orm";

/*
 * Written with explicit table names: inside a query on `archive_items` alone,
 * Drizzle renders a column without its table, and the subqueries below would
 * then compare `archive_item_mailboxes` with itself.
 */

/**
 * Whether an archive item belongs to the protected mailbox `objectId`: an item
 * captured for that mailbox (`archive_items.protected_object_id`, e.g. imported
 * mail) or a journal report assigned to it (`archive_item_mailboxes`, #32).
 * Use it wherever the archive is filtered or held by mailbox, so journal mail
 * is never left out.
 */
export function archiveItemOfMailbox(objectId: string): SQL {
  return sql`("archive_items"."protected_object_id" = ${objectId}::uuid or exists (
    select 1 from "archive_item_mailboxes" "aim"
     where "aim"."archive_item_id" = "archive_items"."id"
       and "aim"."protected_object_id" = ${objectId}::uuid
  ))`;
}

/** Every mailbox an archive item belongs to (its own and its assignments), as a select column. */
export const archiveItemMailboxIds = sql<string[]>`array_remove(
  array_append(
    coalesce((
      select array_agg("aim"."protected_object_id")
        from "archive_item_mailboxes" "aim"
       where "aim"."archive_item_id" = "archive_items"."id"
    ), '{}'::uuid[]),
    "archive_items"."protected_object_id"
  ),
  null
)::text[]`;
