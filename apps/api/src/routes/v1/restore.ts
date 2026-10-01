import type { Database } from "@restow/db";
import { z } from "zod";
import {
  MAX_SELECTION_ENTRIES,
  restoreModeSchema,
  restoreOptionsSchema,
  restoreTargetSchema,
  selectionEntrySchema,
} from "../../features/restore/schemas.js";
import { type RestoreCreatedDto, createRestore } from "../../features/restore/service.js";
import { type KeyActor, asPersonActor } from "./actor.js";
import { type IntegrationApi, type V1Deps, WRITE_ERRORS } from "./api.js";
import { component } from "./components.js";
import { uuidSchema } from "./schemas.js";

/**
 * POST /restore — a restore order from an integration (snapshot, selection,
 * target, reason). The restore feature validates the selection against the
 * snapshot, writes the request, enqueues it and audits it in one transaction.
 *
 * An API key is never the owner of the data it restores, so every
 * integration restore counts as one on the owner's behalf: the reason is
 * mandatory and lands in the audit log next to the key. Progress follows at
 * `GET /jobs/{jobId}` (and its event stream); a download archive is fetched
 * by a tenant administrator in the web UI within 24 hours.
 */

export const restoreRequestSchema = z.object({
  snapshotId: uuidSchema.describe("The snapshot (point in time) to restore from."),
  selection: z
    .array(selectionEntrySchema)
    .min(1)
    .max(MAX_SELECTION_ENTRIES)
    .optional()
    .describe(
      "Folders or items by `path`, or items by source `itemId`; omit to restore the whole snapshot.",
    ),
  target: restoreTargetSchema.describe(
    "`original` writes back into the object, `other` into another account (`accountId`), `download` builds a ZIP archive.",
  ),
  mode: restoreModeSchema
    .default("rename")
    .describe(
      "On collisions: keep both (`rename`) or leave the existing item (`skip`). A restore " +
        "never replaces an existing item: `replace` is refused with 422 " +
        "(urn:restow:problem:restore-replace-not-allowed) unless `target` is `download` (mode " +
        "has no effect on a download archive).",
    ),
  reason: z
    .string()
    .trim()
    .min(3)
    .max(2000)
    .describe("Why the restore is needed, e.g. the ticket; written to the audit log."),
  options: restoreOptionsSchema.optional(),
});
export type RestoreRequest = z.infer<typeof restoreRequestSchema>;

export const restoreAcceptedSchema = component(
  "RestoreAccepted",
  z.object({
    id: uuidSchema.describe("The restore request."),
    jobId: uuidSchema.describe("The job executing it; follow it at `/jobs/{jobId}`."),
    status: z.literal("queued"),
    impersonated: z
      .boolean()
      .describe(
        "Restored on the owner's behalf (always true for API keys; audited with the reason).",
      ),
    selection: z.object({
      all: z.boolean(),
      folders: z.number().int(),
      items: z.number().int(),
    }),
  }),
);
export type RestoreAcceptedDto = z.infer<typeof restoreAcceptedSchema>;

/** The whole snapshot, as the explorer's root path selects it. */
export const WHOLE_SNAPSHOT = [{ path: "" }] as const;

export function toRestoreAccepted(created: RestoreCreatedDto): RestoreAcceptedDto {
  return {
    id: created.id,
    jobId: created.jobId,
    status: created.status,
    impersonated: created.impersonated,
    selection: created.selection,
  };
}

export async function requestRestore(
  db: Database,
  tenantId: string,
  input: RestoreRequest,
  actor: KeyActor,
): Promise<RestoreAcceptedDto> {
  const created = await createRestore(db, tenantId, asPersonActor(actor), {
    snapshotId: input.snapshotId,
    selection: input.selection ?? [...WHOLE_SNAPSHOT],
    target: input.target,
    mode: input.mode,
    reason: input.reason,
    options: input.options,
  });
  return toRestoreAccepted(created);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerRestoreRoutes(api: IntegrationApi, deps: V1Deps): void {
  const { db } = deps;

  api.tenant(
    {
      method: "post",
      path: "/restore",
      operationId: "requestRestore",
      summary: "Order a restore from a snapshot",
      description:
        "The selection is checked against the snapshot. Progress follows at `GET /jobs/{jobId}`. A download archive is fetched in the web UI by a tenant administrator within 24 hours.",
      tag: "Restore",
      scope: "restore:write",
      write: true,
      body: restoreRequestSchema,
      errors: WRITE_ERRORS,
      response: {
        status: 202,
        description: "The restore was queued.",
        schema: restoreAcceptedSchema,
      },
    },
    ({ tenant, actor, input: { body } }) => requestRestore(db, tenant.id, body, actor),
  );
}
