import {
  type Database,
  type RetentionPolicy,
  archiveAnchor,
  archiveItems,
  legalHolds,
  retentionPolicies,
} from "@restow/db";
import { and, asc, count, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { type IntegrationApi, READ_ERRORS, type V1Deps } from "./api.js";
import { V1_AUDIT_ACTIONS, readRecorder } from "./audit.js";
import { component } from "./components.js";
import { timestampSchema, toIso, uuidSchema } from "./schemas.js";

/**
 * Archive evidence for integrations (docs/ARCHIVE.md): GET /archive/status and
 * GET /archive/report. Everything is read from the immutable archive tables —
 * items, daily chain anchors, retention policies and legal holds — so the
 * numbers are exactly what the archive holds.
 *
 * The hash chain itself is verified by the archive's own check. This API
 * reports the result of such a verification; while none is recorded the
 * chain state is `not_verified`, never an optimistic `verified`. A signed PDF
 * rendition of the report is not produced, which `pdfUrl: null` states.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_REPORT_DAYS = 30;
export const MAX_REPORT_DAYS = 366;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const chainStateSchema = component(
  "ArchiveChainState",
  z
    .enum(["verified", "broken", "not_verified"])
    .describe(
      "Result of the latest hash-chain verification of the archive; `not_verified` while no verification result is recorded.",
    ),
);
export type ChainState = z.infer<typeof chainStateSchema>;

/** No verification result is recorded anywhere yet, so none can be claimed. */
export const ARCHIVE_CHAIN_STATE: ChainState = "not_verified";

const channelSchema = z.object({
  lastCapturedAt: timestampSchema.nullable(),
  last24h: z.number().int(),
});

export const retentionPolicySchema = component(
  "RetentionPolicy",
  z.object({
    id: uuidSchema,
    name: z.string(),
    years: z.number().int().nullable().describe("Retention in years; null is unlimited."),
    mode: z
      .enum(["from_capture", "end_of_year"])
      .describe(
        "Clock start: the capture date, or the end of that calendar year (AO § 147 Abs. 4).",
      ),
    isDefault: z.boolean(),
  }),
);
export type RetentionPolicyDto = z.infer<typeof retentionPolicySchema>;

export const archiveStatusSchema = component(
  "ArchiveStatus",
  z.object({
    items: z.object({
      total: z.number().int(),
      objectLocked: z
        .number()
        .int()
        .describe(
          "Items with a retention date. It is not a WORM statement: whether the storage target enforces S3 Object Lock is reported per target by the storage operations.",
        ),
      oldestReceivedAt: timestampSchema.nullable(),
      newestReceivedAt: timestampSchema.nullable(),
    }),
    intake: z.object({
      last24h: z.number().int().describe("Items captured in the last 24 hours."),
      averagePerDay7d: z.number().describe("Average items captured per day over the last 7 days."),
    }),
    channels: z
      .object({
        journal: channelSchema,
        graphSync: channelSchema,
        imapSync: channelSchema,
        fileImport: channelSchema,
      })
      .describe(
        "Per capture channel: Exchange Online journaling (SMTP), Graph sync and IMAP sync. A journal without recent captures is worth a look.",
      ),
    chain: z.object({
      state: chainStateSchema,
      lastAnchorDate: z
        .string()
        .nullable()
        .describe("Day (YYYY-MM-DD) of the newest daily anchor."),
      anchoredDays: z.number().int(),
    }),
    retention: z.object({ policies: z.array(retentionPolicySchema) }),
    legalHolds: z.object({ active: z.number().int() }),
  }),
);
export type ArchiveStatusDto = z.infer<typeof archiveStatusSchema>;

export const archiveReportQuerySchema = z.object({
  from: timestampSchema
    .optional()
    .describe(
      `Start of the period (inclusive); defaults to ${DEFAULT_REPORT_DAYS} days before \`to\`.`,
    ),
  to: timestampSchema.optional().describe("End of the period (exclusive); defaults to now."),
});
export type ArchiveReportQuery = z.infer<typeof archiveReportQuerySchema>;

export const archiveReportSchema = component(
  "ArchiveReport",
  z.object({
    tenant: z.object({ id: uuidSchema, name: z.string() }),
    range: z.object({ from: timestampSchema, to: timestampSchema }),
    generatedAt: timestampSchema,
    items: z
      .object({
        count: z.number().int(),
        bytes: z.number().int(),
        objectLocked: z
          .number()
          .int()
          .describe("Items with a retention date; not a statement about WORM storage."),
        byChannel: z.object({
          journal: z.number().int(),
          graphSync: z.number().int(),
          imapSync: z.number().int(),
          fileImport: z.number().int(),
        }),
        firstReceivedAt: timestampSchema.nullable(),
        lastReceivedAt: timestampSchema.nullable(),
      })
      .describe("Messages received within the period."),
    chain: z.object({
      state: chainStateSchema,
      anchors: z
        .array(
          z.object({
            date: z.string().describe("YYYY-MM-DD"),
            lastHash: z.string().describe("Chain value at the end of the day."),
            count: z.number().int(),
            externalTimestamp: z
              .string()
              .nullable()
              .describe("RFC 3161 timestamp token reference, when one was obtained."),
          }),
        )
        .describe("The daily anchors of the period, oldest first."),
    }),
    retention: z.object({ policies: z.array(retentionPolicySchema) }),
    legalHolds: z
      .array(
        z.object({
          id: uuidSchema,
          reason: z.string(),
          protectedObjectId: uuidSchema.nullable(),
          active: z.boolean(),
          createdAt: timestampSchema,
          releasedAt: timestampSchema.nullable(),
        }),
      )
      .describe("Holds in force at any time during the period."),
    pdfUrl: z
      .string()
      .nullable()
      .describe("Signed PDF rendition; null, PDF reports are not produced."),
  }),
);
export type ArchiveReportDto = z.infer<typeof archiveReportSchema>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface ReportRange {
  from: Date;
  to: Date;
}

/** The report period: defaults filled in, and at most {@link MAX_REPORT_DAYS} long. */
export function reportRange(query: ArchiveReportQuery, now: Date): ReportRange {
  const to = query.to ? new Date(query.to) : now;
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - DEFAULT_REPORT_DAYS * DAY_MS);
  if (from.getTime() >= to.getTime()) {
    throw new ProblemError(422, "Invalid period", {
      type: "urn:restow:problem:invalid-period",
      detail: "`from` must lie before `to`.",
    });
  }
  if (to.getTime() - from.getTime() > MAX_REPORT_DAYS * DAY_MS) {
    throw new ProblemError(422, "Period too long", {
      type: "urn:restow:problem:invalid-period",
      detail: `A report covers at most ${MAX_REPORT_DAYS} days; request longer periods in parts.`,
      extensions: { maxDays: MAX_REPORT_DAYS },
    });
  }
  return { from, to };
}

export function toRetentionPolicy(policy: RetentionPolicy): RetentionPolicyDto {
  return {
    id: policy.id,
    name: policy.name,
    years: policy.years,
    mode: policy.mode,
    isDefault: policy.isDefault,
  };
}

type Channel = "journal" | "graph_sync" | "imap_sync" | "file_import";

function byChannel<T>(rows: readonly { channel: Channel; value: T }[], empty: T) {
  const find = (channel: Channel) => rows.find((row) => row.channel === channel)?.value ?? empty;
  return {
    journal: find("journal"),
    graphSync: find("graph_sync"),
    imapSync: find("imap_sync"),
    fileImport: find("file_import"),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The tenant's archive retention policies, the default first. The
 * `retention_policies` table also holds backup snapshot retention (SNAPSHOT
 * feature, `applies_to.target === "snapshots"`); those rows govern restore
 * points, not the archive, so they are excluded from evidence reporting here.
 */
export function listPolicies(tx: Transaction, tenantId: string) {
  return tx
    .select()
    .from(retentionPolicies)
    .where(
      and(
        eq(retentionPolicies.tenantId, tenantId),
        or(
          isNull(retentionPolicies.appliesTo),
          sql`(${retentionPolicies.appliesTo} ->> 'target') is distinct from 'snapshots'`,
        ),
      ),
    )
    .orderBy(desc(retentionPolicies.isDefault), asc(retentionPolicies.name));
}

export async function loadArchiveStatus(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<ArchiveStatusDto> {
  const since24h = new Date(now.getTime() - DAY_MS);
  const since7d = new Date(now.getTime() - 7 * DAY_MS);
  return withTenantTx(db, tenantId, async (tx) => {
    const [items] = await tx
      .select({
        total: count(),
        objectLocked: sql<number>`count(*) filter (where ${archiveItems.objectLock})`.mapWith(
          Number,
        ),
        oldest: sql<Date | null>`min(${archiveItems.receivedAt})`.mapWith(archiveItems.receivedAt),
        newest: sql<Date | null>`max(${archiveItems.receivedAt})`.mapWith(archiveItems.receivedAt),
        last24h:
          sql<number>`count(*) filter (where ${archiveItems.createdAt} >= ${since24h})`.mapWith(
            Number,
          ),
        last7d:
          sql<number>`count(*) filter (where ${archiveItems.createdAt} >= ${since7d})`.mapWith(
            Number,
          ),
      })
      .from(archiveItems)
      .where(eq(archiveItems.tenantId, tenantId));
    const channels = await tx
      .select({
        channel: archiveItems.capturedVia,
        lastCapturedAt: sql<Date | null>`max(${archiveItems.createdAt})`.mapWith(
          archiveItems.createdAt,
        ),
        last24h:
          sql<number>`count(*) filter (where ${archiveItems.createdAt} >= ${since24h})`.mapWith(
            Number,
          ),
      })
      .from(archiveItems)
      .where(eq(archiveItems.tenantId, tenantId))
      .groupBy(archiveItems.capturedVia);
    const [anchors] = await tx
      .select({
        days: count(),
        lastDate: sql<string | null>`max(${archiveAnchor.anchorDate})`,
      })
      .from(archiveAnchor)
      .where(eq(archiveAnchor.tenantId, tenantId));
    const policies = await listPolicies(tx, tenantId);
    const [holds] = await tx
      .select({ active: count() })
      .from(legalHolds)
      .where(and(eq(legalHolds.tenantId, tenantId), eq(legalHolds.active, true)));

    return {
      items: {
        total: items?.total ?? 0,
        objectLocked: items?.objectLocked ?? 0,
        oldestReceivedAt: toIso(items?.oldest),
        newestReceivedAt: toIso(items?.newest),
      },
      intake: {
        last24h: items?.last24h ?? 0,
        averagePerDay7d: Math.round(((items?.last7d ?? 0) / 7) * 10) / 10,
      },
      channels: byChannel(
        channels.map((row) => ({
          channel: row.channel,
          value: { lastCapturedAt: toIso(row.lastCapturedAt), last24h: row.last24h },
        })),
        { lastCapturedAt: null, last24h: 0 },
      ),
      chain: {
        state: ARCHIVE_CHAIN_STATE,
        lastAnchorDate: anchors?.lastDate ?? null,
        anchoredDays: anchors?.days ?? 0,
      },
      retention: { policies: policies.map(toRetentionPolicy) },
      legalHolds: { active: holds?.active ?? 0 },
    };
  });
}

/** Day (YYYY-MM-DD, UTC) of an instant, for the `date` column of the anchors. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function loadArchiveReport(
  db: Database,
  tenant: { id: string; name: string },
  range: ReportRange,
  now: Date,
): Promise<ArchiveReportDto> {
  const inRange = and(
    eq(archiveItems.tenantId, tenant.id),
    gte(archiveItems.receivedAt, range.from),
    lt(archiveItems.receivedAt, range.to),
  );
  return withTenantTx(db, tenant.id, async (tx) => {
    const [items] = await tx
      .select({
        count: count(),
        bytes: sql<number>`coalesce(sum(${archiveItems.sizeBytes}), 0)`.mapWith(Number),
        objectLocked: sql<number>`count(*) filter (where ${archiveItems.objectLock})`.mapWith(
          Number,
        ),
        first: sql<Date | null>`min(${archiveItems.receivedAt})`.mapWith(archiveItems.receivedAt),
        last: sql<Date | null>`max(${archiveItems.receivedAt})`.mapWith(archiveItems.receivedAt),
      })
      .from(archiveItems)
      .where(inRange);
    const channels = await tx
      .select({ channel: archiveItems.capturedVia, value: count() })
      .from(archiveItems)
      .where(inRange)
      .groupBy(archiveItems.capturedVia);
    const anchors = await tx
      .select({
        date: archiveAnchor.anchorDate,
        lastHash: archiveAnchor.lastHash,
        count: archiveAnchor.count,
        externalTimestamp: archiveAnchor.externalTimestamp,
      })
      .from(archiveAnchor)
      .where(
        and(
          eq(archiveAnchor.tenantId, tenant.id),
          gte(archiveAnchor.anchorDate, utcDay(range.from)),
          lte(archiveAnchor.anchorDate, utcDay(range.to)),
        ),
      )
      .orderBy(asc(archiveAnchor.anchorDate));
    const policies = await listPolicies(tx, tenant.id);
    const holds = await tx
      .select({
        id: legalHolds.id,
        reason: legalHolds.reason,
        protectedObjectId: legalHolds.protectedObjectId,
        active: legalHolds.active,
        createdAt: legalHolds.createdAt,
        releasedAt: legalHolds.releasedAt,
      })
      .from(legalHolds)
      .where(
        and(
          eq(legalHolds.tenantId, tenant.id),
          lt(legalHolds.createdAt, range.to),
          or(isNull(legalHolds.releasedAt), gte(legalHolds.releasedAt, range.from)),
        ),
      )
      .orderBy(asc(legalHolds.createdAt));

    return {
      tenant: { id: tenant.id, name: tenant.name },
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      generatedAt: now.toISOString(),
      items: {
        count: items?.count ?? 0,
        bytes: items?.bytes ?? 0,
        objectLocked: items?.objectLocked ?? 0,
        byChannel: byChannel(channels, 0),
        firstReceivedAt: toIso(items?.first),
        lastReceivedAt: toIso(items?.last),
      },
      chain: { state: ARCHIVE_CHAIN_STATE, anchors },
      retention: { policies: policies.map(toRetentionPolicy) },
      legalHolds: holds.map((hold) => ({
        id: hold.id,
        reason: hold.reason,
        protectedObjectId: hold.protectedObjectId,
        active: hold.active,
        createdAt: hold.createdAt.toISOString(),
        releasedAt: hold.releasedAt?.toISOString() ?? null,
      })),
      pdfUrl: null,
    };
  });
}

/** Newest capture of the tenant's archive (for the status summary). */
export async function lastArchiveCapture(
  tx: Transaction,
  tenantId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({
      at: sql<Date | null>`max(${archiveItems.createdAt})`.mapWith(archiveItems.createdAt),
    })
    .from(archiveItems)
    .where(eq(archiveItems.tenantId, tenantId));
  return toIso(row?.at);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerArchiveRoutes(api: IntegrationApi, deps: V1Deps): void {
  const { db } = deps;
  const recordRead = readRecorder(deps);

  api.tenant(
    {
      method: "get",
      path: "/archive/status",
      operationId: "getArchiveStatus",
      summary: "Archive intake, capture channels, hash chain, retention and legal holds",
      tag: "Archive",
      scope: "archive:read",
      errors: READ_ERRORS,
      response: { status: 200, description: "The archive status.", schema: archiveStatusSchema },
    },
    ({ tenant }) => loadArchiveStatus(db, tenant.id, deps.now()),
  );

  api.tenant(
    {
      method: "get",
      path: "/archive/report",
      operationId: "getArchiveReport",
      summary: "Archive evidence report for a period (at most 366 days)",
      tag: "Archive",
      scope: "archive:read",
      audited: true,
      query: archiveReportQuerySchema,
      errors: READ_ERRORS,
      response: { status: 200, description: "The evidence report.", schema: archiveReportSchema },
    },
    async ({ tenant, actor, input: { query } }) => {
      const now = deps.now();
      const range = reportRange(query, now);
      const report = await loadArchiveReport(db, tenant, range, now);
      await recordRead(tenant.id, actor, {
        action: V1_AUDIT_ACTIONS.archiveReportRead,
        target: tenant.id,
        targetType: "tenant",
        details: { from: report.range.from, to: report.range.to, items: report.items.count },
      });
      return report;
    },
  );
}
