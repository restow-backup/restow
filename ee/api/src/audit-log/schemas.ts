import { z } from "zod";

/** Request schemas for the audit feature (same style as apps/api/src/schemas.ts). */

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * The `tenant` filter value naming the installation chain: events without a
 * tenant (setup, provider-level actions). Tenant chains are named by id.
 */
export const INSTALLATION_CHAIN = "installation";

/** Dotted action codes such as `restore.requested` or a prefix like `restore`. */
const ACTION_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/** Blank query values mean "no filter", not "match the empty string". */
function optionalText(max: number) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
    z.string().trim().max(max).optional(),
  );
}

export const chainFilterSchema = z.union([z.literal(INSTALLATION_CHAIN), z.string().uuid()]);
export type ChainFilterParam = z.infer<typeof chainFilterSchema>;

const instant = z.string().datetime({ offset: true });

export const listAuditQuerySchema = z
  .object({
    /** Provider admins: one tenant's chain or `installation`; omitted = everything. */
    tenant: chainFilterSchema.optional(),
    /** An exact action code, or a dotted prefix matching every action below it. */
    action: z.string().trim().max(200).regex(ACTION_PATTERN).optional(),
    /** Case-insensitive part of the actor label, or an exact actor user id. */
    actor: optionalText(200),
    /** Case-insensitive part of the target. */
    target: optionalText(500),
    /** Entries at or after this instant. */
    from: instant.optional(),
    /** Entries strictly before this instant. */
    to: instant.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    /** Opaque cursor from a previous page's `next`. */
    cursor: z.string().min(1).max(512).optional(),
  })
  .refine((query) => !query.from || !query.to || Date.parse(query.from) < Date.parse(query.to), {
    message: "`from` must be before `to`.",
    path: ["to"],
  });
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;

/** Query of the action facet list and of the chain verification. */
export const chainQuerySchema = z.object({
  tenant: chainFilterSchema.optional(),
});
export type ChainQuery = z.infer<typeof chainQuerySchema>;

export const entryIdParamSchema = z.object({ id: z.string().uuid() });
