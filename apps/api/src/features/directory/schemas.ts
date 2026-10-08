import { z } from "zod";

/** Request schemas of the directory feature (same style as apps/api/src/schemas.ts). */

export const sourceParamSchema = z.object({ sourceId: z.string().uuid() });
export const objectParamSchema = z.object({ id: z.string().uuid() });
export const userParamSchema = z.object({ userId: z.string().uuid() });

export const objectKindSchema = z.enum(["mailbox", "onedrive", "imap"]);
/** The object's stored status (the `protected_objects.status` column). */
export const objectStatusSchema = z.enum(["active", "excluded", "orphaned"]);
/**
 * Status as a filter: `not_selected` is not a stored value but a derived one
 * (an `excluded` object of a `selected`-mode source with no `exclude`
 * override) — the default of that mode, not a decision, so it filters apart
 * from `excluded`. See `isNotSelected` in ./logic.js.
 */
export const objectStatusFilterSchema = z.enum(["active", "excluded", "orphaned", "not_selected"]);
export const objectSortSchema = z.enum(["name", "kind", "status", "createdAt", "updatedAt"]);
/**
 * How an object stands towards the backup jobs: in a job that runs on a schedule, in one that is
 * paused or runs by hand only, or in none. Only eligible objects (active, on a working source) match.
 */
export const objectJobFilterSchema = z.enum(["scheduled", "unscheduled", "none"]);

/** `true`/`false` as a query string, without `z.coerce.boolean()` treating "false" as truthy. */
const booleanFlagSchema = z.enum(["true", "false"]).transform((value) => value === "true");

/** GET /objects query: filters, free-text search and page-based pagination. */
export const objectsQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  kind: objectKindSchema.optional(),
  status: objectStatusFilterSchema.optional(),
  sourceId: z.string().uuid().optional(),
  job: objectJobFilterSchema.optional(),
  /** Sign-in disabled member accounts with a mailbox (shared, resource, blocked). */
  sharedOrBlocked: booleanFlagSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: objectSortSchema.default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
});
export type ObjectsQuery = z.infer<typeof objectsQuerySchema>;
/** The filter fields of {@link ObjectsQuery}, reused (without paging) by the bulk endpoint. */
export const objectsFilterSchema = objectsQuerySchema.pick({
  search: true,
  kind: true,
  status: true,
  sourceId: true,
  job: true,
  sharedOrBlocked: true,
});
export type ObjectsFilter = z.infer<typeof objectsFilterSchema>;

/**
 * The same filter fields as {@link objectsFilterSchema}, for a JSON request
 * body (the bulk endpoint's "select all matching") rather than a query
 * string: `sharedOrBlocked` arrives as a real JSON boolean there, never as
 * the `"true"`/`"false"` text a URL carries.
 */
export const bulkFilterSchema = objectsFilterSchema.extend({
  sharedOrBlocked: z.boolean().optional(),
});

/** GET /sources/:sourceId/groups query. */
export const groupSearchQuerySchema = z.object({
  search: z.string().trim().max(256).default(""),
});

/** GET /people query: a search over name, address and UPN, and how many to return. */
export const peopleQuerySchema = z.object({
  search: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PeopleQuery = z.infer<typeof peopleQuerySchema>;

/** An identity on the exclusion list: object id, UPN or address. */
const identitySchema = z.string().trim().min(1).max(320);

export const rulesSchema = z
  .object({
    mode: z.enum(["all", "group", "selected"]),
    groupId: z.string().trim().max(200).nullable().optional(),
    groupName: z.string().trim().max(256).nullable().optional(),
    exclude: z.array(identitySchema).max(5000).default([]),
    includeSharedMailboxes: z.boolean().default(true),
  })
  .refine((rules) => rules.mode !== "group" || (rules.groupId ?? "").length > 0, {
    message: "Group mode needs a group.",
    path: ["groupId"],
  });
export type RulesInput = z.infer<typeof rulesSchema>;

export const syncRequestSchema = z.object({
  /** Enumerate the whole directory instead of reading only the changes. */
  full: z.boolean().default(false),
});
export type SyncRequest = z.infer<typeof syncRequestSchema>;

/** Per-object override; `reset` returns the object to the rules. */
export const protectionOverrideSchema = z.object({
  action: z.enum(["include", "exclude", "reset"]),
  /** Documented for on-/offboarding; written to the audit log. */
  reason: z.string().trim().min(1).max(1000).optional(),
});
export type ProtectionOverrideInput = z.infer<typeof protectionOverrideSchema>;

export const imapAccountSchema = z.object({
  login: z.string().trim().min(1).max(320),
  email: z.string().trim().max(320).nullable().optional(),
  displayName: z.string().trim().max(256).nullable().optional(),
  /**
   * Only meaningful for a source in `per_mailbox` auth mode (docs/IMAP.md);
   * sealed on arrival and ignored (never stored) otherwise.
   */
  password: z.string().min(1).max(4096).optional(),
});
export type ImapAccountRequest = z.infer<typeof imapAccountSchema>;

/** Body of POST /objects/:id/credential (set/replace a mailbox's own password). */
export const objectCredentialSchema = z.object({
  password: z.string().min(1).max(4096),
});
export type ObjectCredentialInput = z.infer<typeof objectCredentialSchema>;

export const accountsRequestSchema = z.object({
  accounts: z.array(imapAccountSchema).min(1).max(5000),
  /** Validate and report only; nothing is written. */
  dryRun: z.boolean().default(false),
});
export type AccountsRequest = z.infer<typeof accountsRequestSchema>;

/** Objects a bulk decision applies to: an explicit list, or everything a filter matches. */
export const MAX_BULK_OBJECTS = 1000;

export const bulkProtectionSchema = z
  .object({
    action: z.enum(["include", "exclude", "reset"]),
    /** Documented for on-/offboarding and mass changes; written to the audit log. */
    reason: z.string().trim().min(1).max(1000).optional(),
    objectIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_OBJECTS).optional(),
    /** Every object of the source that matches; capped at {@link MAX_BULK_OBJECTS}. */
    filter: bulkFilterSchema.optional(),
  })
  .refine((body) => (body.objectIds === undefined) !== (body.filter === undefined), {
    message: "Give either objectIds or a filter, not both.",
    path: ["objectIds"],
  });
export type BulkProtectionInput = z.infer<typeof bulkProtectionSchema>;

export const csvImportSchema = z.object({
  /**
   * The CSV text (up to 2 MB). A `password`/`pass`/`pwd` header column is
   * accepted (packages/core/src/directory/csv.ts) and sealed on arrival; the
   * file itself is parsed in memory only, never stored or logged.
   */
  csv: z.string().min(1).max(2_000_000),
  /** Parse and report only; nothing is written. */
  dryRun: z.boolean().default(false),
});
export type CsvImportRequest = z.infer<typeof csvImportSchema>;
