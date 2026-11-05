import { causeOfReadinessReason } from "@restow/core";
import { z } from "zod";
import { causeToFailureDto, type FailureDto, failureDto } from "../failures/dto.js";

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

/** `site`: a SharePoint site's own JSON objects (site.json, list schemas, list items), 0.4.9. */
const CATEGORIES = ["mail", "file", "event", "contact", "site"] as const;
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
    // Reports before 0.4.9 have no site category.
    site: count.default(0),
  })
  .catch({ mail: 0, file: 0, event: 0, contact: 0, site: 0 });

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
  bytes: z.number().nonnegative().nullable().optional().catch(null),
});

export interface ReasonDto {
  code: string;
  severity: "yellow" | "red";
  count: number | null;
  ageHours: number | null;
  /** Bytes of content the backup holds (`nothing_to_verify`, 0.4.9); null otherwise. */
  bytes: number | null;
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
        bytes: reason.bytes ?? null,
      });
      return {
        code: reason.code,
        severity: reason.severity,
        count: reason.count ?? null,
        ageHours: reason.ageHours ?? null,
        bytes: reason.bytes ?? null,
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
    eligible: { mail: 0, file: 0, event: 0, contact: 0, site: 0 },
    sampled: { mail: 0, file: 0, event: 0, contact: 0, site: 0 },
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

const optionalCount = count.nullable().optional().catch(null);

/** One measure of the source signal (core manifest `DriveMeasure` / `MailMeasure`). */
const measureSchema = z
  .object({
    rootBytes: optionalCount,
    rootChildren: optionalCount,
    visibleItems: optionalCount,
    hiddenItems: optionalCount,
    folders: optionalCount,
    at: nullableNumber,
  })
  .nullable()
  .catch(null);

/** The source's own size signal and its verdict (core verify/source.ts, 0.5.0). */
const sourceSchema = z
  .object({
    service: z.enum(["onedrive", "mailbox"]),
    verdict: z.enum(["empty", "content", "unknown"]).catch("unknown"),
    bytes: optionalCount,
    items: optionalCount,
    signal: z
      .object({
        before: measureSchema.optional().catch(null),
        after: measureSchema.optional().catch(null),
        quota: z
          .object({ used: nullableNumber, deleted: nullableNumber, total: nullableNumber })
          .nullable()
          .optional()
          .catch(null),
        archive: z.enum(["present", "none", "unknown"]).optional().catch(undefined),
      })
      .nullable()
      .optional()
      .catch(null),
  })
  .nullable()
  .optional()
  .catch(null);

const snapshotSchema = z
  .object({
    id: z.string(),
    sequence: count,
    completedAt: nullableString,
    itemCount: count,
    packCount: count,
    /** Bytes and objects of content (no folders); absent before 0.4.9. */
    contentBytes: optionalCount,
    contentObjects: optionalCount,
    /** What Microsoft 365 itself reported (0.5.0); absent without a signal. */
    source: sourceSchema,
  })
  .nullable()
  .catch(null);

/**
 * What Microsoft 365 itself reported about the object when it was backed up (0.5.0), for the
 * details view: `verdict` is the rule's outcome (core verify/source.ts), the figures are what it
 * rests on. Bytes for a OneDrive (its root folder, and the quota for display), items for a
 * mailbox (visible and hidden folders).
 */
export interface SourceStatsDto {
  service: "onedrive" | "mailbox";
  verdict: "empty" | "content" | "unknown";
  /** OneDrive: bytes below the root, before and after the run (after only for an empty backup). */
  rootBytesBefore: number | null;
  rootBytesAfter: number | null;
  /** OneDrive: the quota Microsoft 365 reports (recycle bin, versions and system lists included). */
  quotaUsed: number | null;
  quotaDeleted: number | null;
  /** Mailbox: items Graph counts in visible and in hidden folders, before the run. */
  visibleItems: number | null;
  hiddenItems: number | null;
  archive: "present" | "none" | "unknown" | null;
}

/** Items and content bytes of the checked backup, from a report's `details.snapshot`. */
export interface ContentStatsDto {
  items: number;
  bytes: number;
  /** What Microsoft 365 itself reported (0.5.0); absent without a signal. */
  source?: SourceStatsDto;
}

function sourceStatsOf(source: z.infer<typeof sourceSchema>): SourceStatsDto | null {
  if (!source) {
    return null;
  }
  const signal = source.signal ?? null;
  return {
    service: source.service,
    verdict: source.verdict,
    rootBytesBefore: signal?.before?.rootBytes ?? null,
    rootBytesAfter: signal?.after?.rootBytes ?? null,
    quotaUsed: signal?.quota?.used ?? null,
    quotaDeleted: signal?.quota?.deleted ?? null,
    visibleItems: signal?.before?.visibleItems ?? null,
    hiddenItems: signal?.before?.hiddenItems ?? null,
    archive: signal?.archive ?? null,
  };
}

/** The content figures of a stored snapshot reference; null for reports before 0.4.9. */
export function parseContentStats(value: unknown): ContentStatsDto | null {
  const snapshot = snapshotSchema.parse(value);
  if (!snapshot || typeof snapshot.contentBytes !== "number") {
    return null;
  }
  const source = sourceStatsOf(snapshot.source);
  return {
    items: snapshot.itemCount,
    bytes: snapshot.contentBytes,
    ...(source ? { source } : {}),
  };
}

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
    // The source signal flattened to the figures the details view shows (SourceStatsDto).
    snapshot: snapshotSchema.transform((snapshot) =>
      snapshot ? { ...snapshot, source: sourceStatsOf(snapshot.source) } : null,
    ),
    /** Why the manifest of the checked snapshot could not be read, when it could not. */
    manifestFailure: z
      .unknown()
      .optional()
      .transform((value) => storedCause(value, at)),
    counts: countsSchema,
    items: listOf(itemSchemaAt(at)),
    itemsOmitted: count,
    damagedPacks: listOf(z.string()),
    /** Packs of the snapshot the storage check could not read lately; older reports have none. */
    unreadablePacks: listOf(
      z.object({ path: z.string().min(1), persistent: z.boolean().catch(false) }),
    ),
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
  /** Reads of the pack from this target; 1 unless a transfer error made the check read again. */
  attempts: z.number().int().positive().catch(1).default(1),
});

/** The run of consecutive checks that could not read a pack. */
const unreadableRunSchema = z
  .object({
    since: z.string(),
    lastAt: z.string(),
    checks: z.number().int().positive(),
    persistent: z.boolean().catch(false),
  })
  .nullable()
  .catch(null)
  .default(null);

const packCheckSchema = z.object({
  path: z.string().min(1),
  targets: listOf(targetCheckSchema),
  /** Set for a pack no target could be read from (not proven damaged). */
  unreadable: unreadableRunSchema,
});
export type PackCheckDto = z.infer<typeof packCheckSchema>;

const scrubFindingSchema = z.object({
  origin: z.literal("scrub"),
  scrubJobId: nullableString,
  packs: listOf(packCheckSchema),
  /** A finding that ends an earlier one: the packs it named were read intact again. */
  cleared: z.boolean().catch(false).default(false),
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
  mode: z.enum(["sample", "full", "recheck"]).catch("sample"),
  packsTotal: count,
  packsChecked: count,
  bytesChecked: count,
  ok: count,
  repaired: listOf(packCheckSchema),
  corrupt: listOf(packCheckSchema),
  /** Packs no target could be read from (not proven damaged); older reports listed them as corrupt. */
  unreadable: listOf(packCheckSchema),
  /** Packs an earlier check left damaged or unreadable that this run read intact again. */
  cleared: z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((paths) => paths.length),
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

/** A pack check with a target that could not be read: not proven damage. */
const hasUnreadableTarget = (pack: PackCheckDto): boolean =>
  pack.targets.some((target) => target.status === "unreadable");

/**
 * A stored scrub report, or null when the job left none (older worker, failed
 * run). Reports before 0.4.2 listed packs that could not be read under
 * `corrupt`; they move to `unreadable` here, so a broken download is never
 * shown as damage.
 */
export function parseScrubReport(value: unknown): ScrubReportDto | null {
  const parsed = scrubReportSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const report = parsed.data;
  const legacy = report.corrupt.filter(hasUnreadableTarget);
  if (legacy.length === 0) {
    return report;
  }
  return {
    ...report,
    corrupt: report.corrupt.filter((pack) => !hasUnreadableTarget(pack)),
    unreadable: [...legacy, ...report.unreadable],
  };
}
