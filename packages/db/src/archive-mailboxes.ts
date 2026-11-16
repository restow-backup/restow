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

/**
 * How much earlier than an item's capture time (`archive_items.received_at`, the worker's
 * clock) its assignment may be stamped (`archive_item_mailboxes.created_at`, the database's
 * `now()` at the start of the appending transaction). An assignment is written together
 * with its item or later, never before it; the margin only covers clock skew between the
 * worker and the database.
 */
export const ASSIGNMENT_CLOCK_SKEW_MS = 60 * 60 * 1000;

/**
 * The same membership as {@link archiveItemOfMailbox}, written for a listing of one
 * mailbox's items rather than a check of a few known ones: the ids of the mailbox's own
 * captures (an index range on `archive_items_tenant_object_received_idx`) and of the items
 * assigned to it (an index range on `archive_item_mailboxes_object_created_idx`), each from
 * `since` on when given, as one `archive_items.id in (… union all …)`. The `or exists` form
 * cannot use an index for the listing and reads every item of the tenant; this one reads the
 * mailbox's rows since `since` only, also in a tenant whose archive reaches the mailboxes by
 * journal reports or forwarded copies (written without a mailbox, assigned to it).
 *
 * The assignments are bounded by their own time, which is at or after their item's capture
 * time up to {@link ASSIGNMENT_CLOCK_SKEW_MS}: a prefilter that never drops an item captured
 * from `since` on. The caller keeps the exact `archive_items.received_at >= since`.
 */
export function archiveItemIdsOfMailbox(
  tenantId: string,
  objectId: string,
  since: Date | null = null,
): SQL {
  const own = since ? sql` and "own"."received_at" >= ${since.toISOString()}::timestamptz` : sql``;
  const assigned = since
    ? sql` and "aim"."created_at" >= ${new Date(since.getTime() - ASSIGNMENT_CLOCK_SKEW_MS).toISOString()}::timestamptz`
    : sql``;
  return sql`"archive_items"."id" in (
    select "own"."id" from "archive_items" "own"
     where "own"."tenant_id" = ${tenantId}::uuid
       and "own"."protected_object_id" = ${objectId}::uuid${own}
    union all
    select "aim"."archive_item_id" from "archive_item_mailboxes" "aim"
     where "aim"."tenant_id" = ${tenantId}::uuid
       and "aim"."protected_object_id" = ${objectId}::uuid${assigned}
  )`;
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
