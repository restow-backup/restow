import type { Database } from "@restow/db";
import { z } from "zod";
import { MAX_SAMPLE_SIZE } from "../../features/verify/schemas.js";
import {
  type ReadinessOverviewDto,
  type RunVerifyResultDto,
  readinessOverview,
  runVerify,
} from "../../features/verify/service.js";
import { type KeyActor, asPersonActor } from "./actor.js";
import { type IntegrationApi, READ_ERRORS, type V1Deps, WRITE_ERRORS } from "./api.js";
import { V1_AUDIT_ACTIONS, readRecorder } from "./audit.js";
import { component } from "./components.js";
import { decodeCursor, encodeCursor, idCursorSchema } from "./cursor.js";
import {
  failureSchema,
  nextCursorSchema,
  objectKindSchema,
  objectStatusSchema,
  pageQuerySchema,
  readinessSchema,
  readinessStateSchema,
  timestampSchema,
  uuidSchema,
} from "./schemas.js";

/**
 * Recovery readiness for integrations: GET /verify/latest (the contract proof
 * of the latest test restores, e.g. for a semi-annual report) and POST /verify
 * (test restore now). The ratings, the rules behind them and the enqueueing
 * are the verify feature's; this module shapes them for v1. A rating belongs
 * to the backup it checked: after a new backup the object reads `unverified`
 * until that backup was checked (features/verify/verification-state.ts).
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const verifyKindSchema = z
  .enum(["verify", "health_check"])
  .describe(
    "`verify` restores a random sample into a check target; `health_check` reconciles every item against the live source (expensive, costs Graph/IMAP quota).",
  );

export const verifyRequestSchema = z.object({
  protectedObjectId: uuidSchema
    .optional()
    .describe("The object to check; omit to check every object that has a backup."),
  kind: verifyKindSchema.default("verify"),
  sampleSize: z
    .number()
    .int()
    .min(1)
    .max(MAX_SAMPLE_SIZE)
    .optional()
    .describe("Items per category for a `verify` run; the worker default when omitted."),
  unverifiedOnly: z
    .boolean()
    .optional()
    .describe(
      "Without `protectedObjectId`: check only the objects whose newest backup is not verified yet.",
    ),
});
export type VerifyRequest = z.infer<typeof verifyRequestSchema>;

export const verifyAcceptedSchema = component(
  "VerificationAccepted",
  z.object({
    queued: z.array(
      z.object({
        jobId: uuidSchema,
        protectedObjectId: uuidSchema,
        displayName: z.string().nullable(),
        kind: verifyKindSchema,
      }),
    ),
    skipped: z.array(
      z.object({
        protectedObjectId: uuidSchema,
        displayName: z.string().nullable(),
        reason: z.enum(["no_backup", "excluded", "already_queued"]),
      }),
    ),
  }),
);
export type VerifyAcceptedDto = z.infer<typeof verifyAcceptedSchema>;

export const verifyLatestQuerySchema = pageQuerySchema(100);
export type VerifyLatestQuery = z.infer<typeof verifyLatestQuerySchema>;

export const readinessSummarySchema = component(
  "ReadinessSummary",
  z.object({
    total: z.number().int().describe("Objects that take part in the rating."),
    green: z.number().int(),
    yellow: z.number().int(),
    red: z.number().int(),
    unverified: z
      .number()
      .int()
      .describe("Objects whose newest backup was not verified yet, whatever older backups scored."),
    noBackup: z.number().int(),
    overdue: z.number().int(),
    overall: readinessSchema
      .nullable()
      .describe(
        "Worst state over all objects (unverified or no backup rate red); null without objects.",
      ),
    lastCheckedAt: timestampSchema.nullable(),
    running: z.number().int().describe("Checks queued or running right now."),
  }),
);

const reasonSchema = z.object({
  code: z.string().describe("Machine-readable reason, e.g. `items_mismatched`."),
  severity: z.enum(["yellow", "red"]),
  count: z.number().int().nullable(),
  ageHours: z.number().nullable(),
  failure: failureSchema
    .nullable()
    .describe("The reason explained: what happened, why and what to do."),
});

export const previousCheckSchema = component(
  "PreviousVerification",
  z
    .object({
      reportId: uuidSchema,
      rating: readinessSchema,
      checkedAt: timestampSchema,
      snapshotId: uuidSchema
        .nullable()
        .describe("The older backup it checked; null for reports that name none."),
    })
    .describe(
      "The newest check of an older backup while the newest backup is not verified yet. It says what was proven before, never what holds for the newest backup.",
    ),
);

export const objectVerifySchema = component(
  "ObjectVerification",
  z
    .object({
      protectedObjectId: uuidSchema,
      kind: objectKindSchema,
      displayName: z.string().nullable(),
      externalId: z.string(),
      status: objectStatusSchema,
      state: readinessStateSchema,
      rating: readinessSchema
        .nullable()
        .describe("The rating of the newest backup; null while it is unverified."),
      checkedAt: timestampSchema.nullable().describe("When the rating was established."),
      overdue: z.boolean(),
      latestSnapshotId: uuidSchema.nullable().describe("The newest completed backup."),
      latestSnapshotAt: timestampSchema.nullable(),
      report: z
        .object({ id: uuidSchema, kind: verifyKindSchema, reasons: z.array(reasonSchema) })
        .nullable()
        .describe("The report behind the rating."),
      previousCheck: previousCheckSchema.nullable(),
    })
    .describe(
      "Readiness of an object's newest backup: its rating, `unverified` while no check of that backup ran (whatever an older backup scored), or `no_backup`.",
    ),
);
export type ObjectVerifyDto = z.infer<typeof objectVerifySchema>;

export const verifyLatestSchema = component(
  "VerificationReport",
  z.object({
    summary: readinessSummarySchema,
    storageIntegrity: z
      .object({
        state: z
          .enum(["ok", "repaired", "corrupt", "never"])
          .describe("Result of the latest storage scrub; `never` until one ran."),
        lastCheckedAt: timestampSchema.nullable(),
        lastFullCheckAt: timestampSchema.nullable(),
      })
      .describe("Integrity of the chunk store the backups live in."),
    items: z.array(objectVerifySchema),
    next: nextCursorSchema,
  }),
);
export type VerifyLatestDto = z.infer<typeof verifyLatestSchema>;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toObjectVerify(entry: ReadinessOverviewDto["objects"][number]): ObjectVerifyDto {
  return {
    protectedObjectId: entry.object.id,
    kind: entry.object.kind,
    displayName: entry.object.displayName,
    externalId: entry.object.externalId,
    status: entry.object.status,
    state: entry.state,
    rating: entry.readiness,
    checkedAt: entry.checkedAt,
    overdue: entry.overdue,
    latestSnapshotId: entry.latestSnapshotId ?? null,
    latestSnapshotAt: entry.latestSnapshotAt,
    report: entry.report
      ? { id: entry.report.id, kind: entry.report.kind, reasons: entry.report.reasons }
      : null,
    previousCheck: entry.previousCheck
      ? {
          reportId: entry.previousCheck.reportId,
          rating: entry.previousCheck.readiness,
          checkedAt: entry.previousCheck.checkedAt,
          snapshotId: entry.previousCheck.snapshotId,
        }
      : null,
  };
}

/**
 * A page of the overview. The per-object list pages by object id; the summary
 * and the storage integrity always describe the whole tenant.
 */
export function pageOverview(
  overview: ReadinessOverviewDto,
  limit: number,
  afterId: string | null,
): VerifyLatestDto {
  const ordered = [...overview.objects]
    .sort((a, b) => (a.object.id < b.object.id ? -1 : a.object.id > b.object.id ? 1 : 0))
    .filter((entry) => afterId === null || entry.object.id > afterId);
  const page = ordered.slice(0, limit);
  const last = page.at(-1);
  return {
    summary: overview.summary,
    storageIntegrity: {
      state: overview.storage.state,
      lastCheckedAt: overview.storage.latest?.completedAt ?? null,
      lastFullCheckAt: overview.storage.lastFullAt,
    },
    items: page.map(toObjectVerify),
    next: ordered.length > limit && last ? encodeCursor({ id: last.object.id }) : null,
  };
}

export function toVerifyAccepted(result: RunVerifyResultDto): VerifyAcceptedDto {
  return {
    queued: result.queued.map(({ jobId, protectedObjectId, displayName, kind }) => ({
      jobId,
      protectedObjectId,
      displayName,
      kind,
    })),
    skipped: result.skipped.map(({ protectedObjectId, displayName, reason }) => ({
      protectedObjectId,
      displayName,
      reason,
    })),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export async function latestVerification(
  db: Database,
  tenantId: string,
  query: VerifyLatestQuery,
  now: Date,
): Promise<VerifyLatestDto> {
  const cursor = decodeCursor(idCursorSchema, query.cursor);
  const overview = await readinessOverview(db, tenantId, now);
  return pageOverview(overview, query.limit, cursor?.id ?? null);
}

export async function requestVerification(
  db: Database,
  tenantId: string,
  input: VerifyRequest,
  actor: KeyActor,
): Promise<VerifyAcceptedDto> {
  return toVerifyAccepted(await runVerify(db, tenantId, input, asPersonActor(actor)));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerVerifyRoutes(api: IntegrationApi, deps: V1Deps): void {
  const { db } = deps;
  const recordRead = readRecorder(deps);

  api.tenant(
    {
      method: "get",
      path: "/verify/latest",
      operationId: "getLatestVerification",
      summary: "Latest recovery readiness per object (proof of test restores)",
      description:
        "The summary and storage integrity describe the whole tenant; the per-object list pages by object id.",
      tag: "Verification",
      scope: "status:read",
      audited: true,
      query: verifyLatestQuerySchema,
      errors: READ_ERRORS,
      response: { status: 200, description: "The readiness report.", schema: verifyLatestSchema },
    },
    async ({ tenant, actor, input: { query } }) => {
      const report = await latestVerification(db, tenant.id, query, deps.now());
      await recordRead(tenant.id, actor, {
        action: V1_AUDIT_ACTIONS.verifyRead,
        target: tenant.id,
        targetType: "tenant",
        details: { count: report.items.length, overall: report.summary.overall },
      });
      return report;
    },
  );

  api.tenant(
    {
      method: "post",
      path: "/verify",
      operationId: "startVerification",
      summary: "Start a test restore (or a health check) now",
      tag: "Verification",
      scope: "verify:write",
      write: true,
      body: verifyRequestSchema,
      errors: WRITE_ERRORS,
      response: { status: 202, description: "The queued checks.", schema: verifyAcceptedSchema },
    },
    ({ tenant, actor, input: { body } }) => requestVerification(db, tenant.id, body, actor),
  );
}
