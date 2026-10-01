import { z } from "zod";
import { component } from "./components.js";

/**
 * Building blocks shared by the `/api/v1` integration schemas. Every request
 * and response of the surface is a zod schema: requests are validated with it,
 * handler results are typed by it, and the OpenAPI document is generated from
 * it (./openapi.ts), so the three can never drift apart.
 *
 * Conventions (docs/ARCHITECTURE.md, "API"): times are ISO 8601 UTC strings,
 * sizes are bytes, lists page with an opaque cursor (`next`, null when
 * exhausted) and at most {@link MAX_PAGE_SIZE} items.
 */

export const MAX_PAGE_SIZE = 500;

export const uuidSchema = z.string().uuid();

export const timestampSchema = z.string().datetime({ offset: true });

export const readinessSchema = component(
  "Readiness",
  z
    .enum(["green", "yellow", "red"])
    .describe("Recovery readiness rating of the latest verification."),
);

export const readinessStateSchema = component(
  "ReadinessState",
  z
    .enum(["green", "yellow", "red", "unverified", "no_backup"])
    .describe(
      "Readiness of an object: the latest rating, `unverified` (backed up but never proven by a test restore) or `no_backup`.",
    ),
);

export const objectKindSchema = component("ObjectKind", z.enum(["mailbox", "onedrive", "imap"]));
export const objectStatusSchema = component(
  "ObjectStatus",
  z
    .enum(["active", "excluded", "orphaned"])
    .describe(
      "`active` is protected, `excluded` was taken out of protection, `orphaned` disappeared from the source (its backups stay restorable).",
    ),
);
export const sourceKindSchema = component("SourceKind", z.enum(["m365", "imap"]));

export const jobTypeSchema = component(
  "JobType",
  z.enum([
    "backup",
    "restore",
    "verify",
    "archive",
    "directory",
    "retention",
    "scrub",
    "storage_migration",
    "import",
    "export",
  ]),
);
export const jobStatusSchema = component(
  "JobStatus",
  z.enum(["queued", "active", "completed", "failed", "cancelled"]),
);

/**
 * Why something failed, machine-readable and with what to do about it: the
 * shared explanation behind failed jobs, failed items, broken sources and red
 * verifications. `code` is stable (see the troubleshooting page); the texts
 * are the client's to write, the ids in `steps` say what to do.
 */
export const failureSchema = component(
  "Failure",
  z.object({
    code: z
      .string()
      .describe(
        "Stable cause code, e.g. `graph.consent_missing`, `graph.throttled`, `imap.auth_failed`, `storage.full`, `verify.hash_mismatch`, or `unknown`.",
      ),
    category: z
      .string()
      .nullable()
      .describe(
        "Group of the code: microsoft, imap, network, storage, crypto, verify, config, system.",
      ),
    transient: z.boolean().describe("Waiting alone may help; the run is retried automatically."),
    retryable: z.boolean().describe("A manual retry makes sense once the cause is fixed."),
    params: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .describe(
        "Facts of this failure: the missing permission, the host, the seconds to wait, ...",
      ),
    technical: z
      .record(z.union([z.string(), z.number()]))
      .describe(
        "Redacted details for a support case: HTTP status, Graph error code, request-id, client-request-id, server time, endpoint.",
      ),
    occurredAt: timestampSchema,
    step: z.string().nullable().describe("The step (engine phase) the run was in."),
    retry: z
      .object({
        attempt: z.number().int(),
        limit: z.number().int(),
        nextAttemptAt: timestampSchema.nullable(),
      })
      .nullable()
      .describe("Automatic retry state of a run that failed but is queued again."),
    steps: z
      .array(z.object({ id: z.string(), target: z.string().nullable() }))
      .describe("What to do, in order. `target` names the place in the UI for the step."),
    docsUrl: z.string().describe("The troubleshooting page for more help."),
  }),
);
export type V1FailureDto = z.infer<typeof failureSchema>;

export const idParamSchema = z.object({ id: uuidSchema });

/** `limit` and `cursor` of every paged list. */
export function pageQuerySchema(defaultLimit: number) {
  return z.object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(defaultLimit)
      .describe(`Page size, at most ${MAX_PAGE_SIZE}.`),
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe("Opaque cursor from the previous page's `next`."),
  });
}

export const nextCursorSchema = z
  .string()
  .nullable()
  .describe("Cursor of the next page; null on the last page.");

/** A page of `item`, optionally with the total number of matches. */
export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), next: nextCursorSchema });
}

/** RFC 7807 problem details, the error body of every endpoint. */
export const problemSchema = z
  .object({
    type: z.string().describe("URI reference identifying the problem type; `about:blank` if none."),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
  })
  .passthrough()
  .describe("RFC 7807 problem details. Extension members carry machine-readable context.");

/** An ISO string from a Date or the raw timestamp text of an aggregate; null stays null. */
export function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
