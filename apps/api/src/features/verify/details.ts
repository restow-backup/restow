import { causeOfReadinessReason } from "@restow/core";
import { z } from "zod";
import { type FailureDto, causeToFailureDto, failureDto } from "../failures/dto.js";

/**
 * Tolerant readers for what the worker persists: `verify_reports.details`
 * (packages/core/src/verify/report.ts, scrub.ts) and the scrub report in
 * `jobs.payload.result`. The stored format is versioned and may carry fields
 * this API does not know yet, or miss fields older workers never wrote; every
 * reader here keeps what it understands and fills the rest with honest
 * defaults instead of failing the whole response.
 */

const readinessSchema = z.enum(["green", "yellow", "red"]);
export type Readiness = z.infer<typeof readinessSchema>;

const CATEGORIES = ["mail", "file", "event", "contact"] as const;
export type SampleCategory = (typeof CATEGORIES)[number];

const count = z.number().int().nonnegative().catch(0);
const nullableString = z.string().nullable().catch(null);
const nullableNumber = z.number().nullable().catch(null);

const categoryCounts = z
  .object({
    mail: count,
    file: count,
    event: count,
    contact: count,
  })
  .catch({ mail: 0, file: 0, event: 0, contact: 0 });

function listOf<T extends z.ZodTypeAny>(item: T) {
  // Keep every valid entry, drop the ones that do not parse.
  return z
    .array(z.unknown())
    .catch([])
    .transform((entries) =>
      entries.flatMap((entry) => {
        const parsed = item.safeParse(entry);
        return parsed.success ? [parsed.data as z.infer<T>] : [];
      }),
    );
}

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

const reasonSchema = z.object({
  /** Machine code; the UI translates known codes and shows a generic text otherwise. */
  code: z.string().min(1).max(64),
  severity: z.enum(["yellow", "red"]),
  count: z.number().int().nonnegative().nullable().optional().catch(null),
  ageHours: z.number().nonnegative().nullable().optional().catch(null),
});

export interface ReasonDto {
  code: string;
  severity: "yellow" | "red";
  count: number | null;
  ageHours: number | null;
  /**
   * The reason explained: why it is not green, what happened and what to do
   * (a `verify.*` cause with steps). Null for a reason code this version does
   * not know; the UI then shows the generic text.
   */
  failure: FailureDto | null;
}

/** The epoch, standing in when the caller has no time to give (a cause without a report). */
const UNKNOWN_TIME = new Date(0);

export function parseReasons(value: unknown, at: Date = UNKNOWN_TIME): ReasonDto[] {
  return listOf(reasonSchema)
    .parse(value)
    .map((reason) => {
      const cause = causeOfReadinessReason({
        code: reason.code,
        count: reason.count ?? null,
        ageHours: reason.ageHours ?? null,
      });
      return {
        code: reason.code,
        severity: reason.severity,
        count: reason.count ?? null,
        ageHours: reason.ageHours ?? null,
        failure: cause ? causeToFailureDto(cause, at) : null,
      };
    });
}

/**
 * A cause stored inside a report (`ItemCheck.cause`, a test-restore item, the
 * manifest), as a failure DTO dated at the report. Anything unusable is null.
 */
function storedCause(value: unknown, at: string): FailureDto | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  return failureDto({ ...(value as Record<string, unknown>), occurredAt: at });
}

const causeField = (at: string) =>
  z
    .unknown()
    .optional()
    .transform((value) => storedCause(value, at));

// ---------------------------------------------------------------------------
// Verify report details
// ---------------------------------------------------------------------------

const countsSchema = z
  .object({
    eligible: categoryCounts,
    sampled: categoryCounts,
    checked: count,
    verified: count,
    mismatch: count,
    missing: count,
    unreadable: count,
    bytesRead: count,
  })
  .catch({
    eligible: { mail: 0, file: 0, event: 0, contact: 0 },
    sampled: { mail: 0, file: 0, event: 0, contact: 0 },
    checked: 0,
    verified: 0,
    mismatch: 0,
    missing: 0,
    unreadable: 0,
    bytesRead: 0,
  });
export type CountsDto = z.infer<typeof countsSchema>;

const itemSchemaAt = (at: string) =>
  z.object({
    path: z.string().min(1),
    id: nullableString,
    category: z.enum(CATEGORIES).catch("file"),
    size: count,
    bytesRead: count,
    chunks: count,
    status: z.enum(["verified", "mismatch", "missing", "unreadable"]),
    objectHash: z
      .enum(["matched", "mismatched", "not_recorded", "not_reached"])
      .catch("not_reached"),
    reason: nullableString,
    /** Why this item did not come back intact (why, what to do); null for a verified item. */
    failure: causeField(at),
  });
export type ItemDto = z.infer<ReturnType<typeof itemSchemaAt>>;

const snapshotSchema = z
  .object({
    id: z.string(),
    sequence: count,
    completedAt: nullableString,
    itemCount: count,
    packCount: count,
  })
  .nullable()
  .catch(null);

const testRestoreSchemaAt = (at: string) =>
  z
    .object({
      target: z.string(),
      items: listOf(
        z.object({
          path: z.string(),
          status: z.enum(["confirmed", "unconfirmed", "failed"]),
          reason: nullableString,
          /** Why the target did not take the item; null when it did or the cause is unknown. */
          failure: causeField(at),
        }),
      ),
    })
    .nullable()
    .catch(null);

const verifyDetailsSchemaAt = (at: string) =>
  z.object({
    origin: z.literal("verify"),
    kind: z.enum(["verify", "health_check"]).catch("verify"),
    scope: z.enum(["sample", "all"]).catch("sample"),
    seed: nullableNumber,
    snapshot: snapshotSchema,
    /** Why the manifest of the checked snapshot could not be read, when it could not. */
    manifestFailure: z
      .unknown()
      .optional()
      .transform((value) => storedCause(value, at)),
    counts: countsSchema,
    items: listOf(itemSchemaAt(at)),
    itemsOmitted: count,
    damagedPacks: listOf(z.string()),
    testRestore: testRestoreSchemaAt(at),
    startedAt: nullableString,
    durationMs: nullableNumber,
  });
export type VerifyDetailsDto = z.infer<ReturnType<typeof verifyDetailsSchemaAt>>;

// ---------------------------------------------------------------------------
// Scrub findings and scrub reports
// ---------------------------------------------------------------------------

const targetCheckSchema = z.object({
  target: count,
  status: z.string().min(1),
  detail: nullableString,
  repaired: z.boolean().catch(false),
});

const packCheckSchema = z.object({
  path: z.string().min(1),
  targets: listOf(targetCheckSchema),
});
export type PackCheckDto = z.infer<typeof packCheckSchema>;

const scrubFindingSchema = z.object({
  origin: z.literal("scrub"),
  scrubJobId: nullableString,
  packs: listOf(packCheckSchema),
});
export type ScrubFindingDto = z.infer<typeof scrubFindingSchema>;

export type ReportDetailsDto = VerifyDetailsDto | ScrubFindingDto | { origin: "unknown" };

/** `at`: when the report was made, the time its embedded causes are dated at. */
export function parseDetails(value: unknown, at: Date = UNKNOWN_TIME): ReportDetailsDto {
  const origin = (value as { origin?: unknown } | null)?.origin;
  if (origin === "verify") {
    const parsed = verifyDetailsSchemaAt(at.toISOString()).safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
  }
  if (origin === "scrub") {
    const parsed = scrubFindingSchema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return { origin: "unknown" };
}

/** Checked / verified / failed at a glance, from a report's stored counts. */
export interface CountSummaryDto {
  checked: number;
  verified: number;
  failed: number;
}

export function parseCountSummary(value: unknown): CountSummaryDto | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const counts = countsSchema.parse(value);
  return {
    checked: counts.checked,
    verified: counts.verified,
    failed: counts.mismatch + counts.missing + counts.unreadable,
  };
}

const gcSchema = z
  .union([
    z.object({
      status: z.literal("completed"),
      packsRewritten: count,
      packsRemoved: count,
      chunksDropped: count,
      bytesReclaimed: count,
      conflicts: count,
      interruptedBy: nullableString,
      skipped: z
        .array(z.unknown())
        .catch([])
        .transform((entries) => entries.length),
    }),
    z.object({ status: z.literal("skipped"), reason: z.string() }),
  ])
  .nullable()
  .catch(null);

const scrubReportSchema = z.object({
  mode: z.enum(["sample", "full"]).catch("sample"),
  packsTotal: count,
  packsChecked: count,
  bytesChecked: count,
  ok: count,
  repaired: listOf(packCheckSchema),
  corrupt: listOf(packCheckSchema),
  /** Damaged packs later backups made redundant (their content was written again); older reports have none. */
  retired: z
    .array(z.unknown())
    .catch([])
    .transform((paths) => paths.length),
  gc: gcSchema,
  orphans: z.object({ removed: count, bytes: count, kept: count }).nullable().catch(null),
  durationMs: nullableNumber,
});
export type ScrubReportDto = z.infer<typeof scrubReportSchema>;

/** A stored scrub report, or null when the job left none (older worker, failed run). */
export function parseScrubReport(value: unknown): ScrubReportDto | null {
  const parsed = scrubReportSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
