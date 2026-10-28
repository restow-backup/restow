/**
 * `source.app_secret_expiring`: the credential of a source's own Microsoft 365 app runs out
 * (docs/ENTRA-SETUP.md, "Expiry"). Without it the backups of that source just started failing
 * to sign in on the day the secret ran out, and nobody had been told beforehand.
 *
 * The date is public and lives in `sources.config.ownApp` (written by the API's
 * `connectOwnApp`): `secretExpiresAt` for a client secret (noted by the admin from the Entra
 * portal, optional), `certificateNotAfter` for a certificate. Nothing has to be unsealed.
 *
 * Reminders follow the stages of @restow/core `secretExpiryAlertDue`: 30 days before, 7 days
 * before and once it has run out, each at most once per date. The mark of the last reminder is
 * `config.ownApp.expiryAlert = { expiresAt, stage, at }`, written with `jsonb_set` in the same
 * transaction as the notification, so the API's concurrent writes to other config keys survive.
 * A new date (rotation, edited date, new certificate) starts over: the API drops the mark, and
 * a mark for another date counts as none anyway. The central app is checked by the API
 * (features/updates/secret-watch.ts), not here.
 *
 * Runs with the endpoint monitor, every five minutes, across all active tenants.
 */
import {
  daysLeft,
  isSecretExpiryAlertStage,
  SECRET_WARNING_DAYS,
  type SecretExpiryAlertMark,
  type SecretExpiryAlertStage,
  secretExpiryAlertDue,
} from "@restow/core";
import { type NewNotification, sources, tenants } from "@restow/db";
import { and, eq, ne, sql } from "drizzle-orm";
import type { EndpointJobDeps } from "./endpoints/common.js";
import { withTenantTx } from "./handlers/framework.js";
import { raiseEvents } from "./reporting.js";

/** At most this many sources per pass: an outage of the monitor must not flood. */
const MAX_SOURCES_PER_PASS = 5000;

const DAY_MS = 86_400_000;

/** What the check reads of `config.ownApp`; the rest belongs to the API's sources feature. */
export interface OwnAppExpiryFacts {
  clientId?: unknown;
  credentialKind?: unknown;
  secretExpiresAt?: unknown;
  certificateNotAfter?: unknown;
  expiryAlert?: unknown;
}

/**
 * When the credential of the own app ends: a certificate's `notAfter`, else the secret's noted
 * date. The field of the other kind is a fallback only, for a record written before the kind
 * was known. Null when no date is known (nothing to remind of).
 */
export function ownAppExpiresAt(ownApp: OwnAppExpiryFacts | null | undefined): string | null {
  if (!ownApp || typeof ownApp !== "object") {
    return null;
  }
  const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  const secret = text(ownApp.secretExpiresAt);
  const certificate = text(ownApp.certificateNotAfter);
  return ownApp.credentialKind === "certificate"
    ? (certificate ?? secret)
    : (secret ?? certificate);
}

/** The reminder already sent, when the stored mark is readable. */
function markOf(value: unknown): SecretExpiryAlertMark | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const mark = value as Record<string, unknown>;
  return typeof mark.expiresAt === "string" && isSecretExpiryAlertStage(mark.stage)
    ? { expiresAt: mark.expiresAt, stage: mark.stage, at: String(mark.at ?? "") }
    : null;
}

/** The stage due for a source now, or null (no date, still far, already reminded). */
export function sourceAppAlertDue(
  ownApp: OwnAppExpiryFacts | null | undefined,
  now: Date,
): { expiresAt: string; stage: SecretExpiryAlertStage } | null {
  const expiresAt = ownAppExpiresAt(ownApp);
  if (expiresAt === null) {
    return null;
  }
  const stage = secretExpiryAlertDue(expiresAt, markOf(ownApp?.expiryAlert), now);
  return stage === null ? null : { expiresAt, stage };
}

/** The notification of one reminder; the bell and mail texts come from the catalog's keys. */
export function sourceAppNotification(
  source: { id: string; tenantId: string; name: string },
  ownApp: OwnAppExpiryFacts,
  due: { expiresAt: string; stage: SecretExpiryAlertStage },
  now: Date,
): NewNotification {
  const clientId = typeof ownApp.clientId === "string" ? ownApp.clientId : "";
  const credentialKind = ownApp.credentialKind === "certificate" ? "certificate" : "secret";
  const credential = credentialKind === "certificate" ? "certificate" : "client secret";
  const date = due.expiresAt.slice(0, 10);
  const days = daysLeft(due.expiresAt, now) ?? 0;
  const app = clientId ? `the Microsoft 365 app ${clientId}` : "the own Microsoft 365 app";
  return {
    tenantId: source.tenantId,
    level: due.stage === "expired" ? "error" : "warning",
    event: "source.app_secret_expiring",
    message:
      due.stage === "expired"
        ? `The ${credential} of ${app} of the source ${source.name} expired on ${date}; its backups cannot sign in until a new one is entered.`
        : `The ${credential} of ${app} of the source ${source.name} expires on ${date} (in ${days} ${days === 1 ? "day" : "days"}).`,
    details: {
      sourceId: source.id,
      objectName: source.name,
      clientId,
      credentialKind,
      expiresAt: due.expiresAt,
      days,
      stage: due.stage,
    },
  };
}

/**
 * Raise the due reminders of every active tenant's own-app sources; returns how many.
 *
 * The limit applies to candidates only: SQL already leaves out dates further away than the
 * first stage and dates whose last stage (`expired`) was reminded of, and the soonest ends come
 * first, so the sources that are due are never crowded out by ones that are not.
 * `sourceAppAlertDue` still decides each row exactly. The dates are compared as ISO 8601 text
 * (byte order), so an unreadable value cannot break the pass.
 */
export async function alertSourceAppSecrets(
  deps: EndpointJobDeps,
  now: Date,
  options: { limit?: number } = {},
): Promise<number> {
  // The same choice as `ownAppExpiresAt`: a certificate's notAfter first, else the secret's.
  const expiresAt = sql`(CASE WHEN ${sources.config}->'ownApp'->>'credentialKind' = 'certificate'
    THEN coalesce(${sources.config}->'ownApp'->>'certificateNotAfter', ${sources.config}->'ownApp'->>'secretExpiresAt')
    ELSE coalesce(${sources.config}->'ownApp'->>'secretExpiresAt', ${sources.config}->'ownApp'->>'certificateNotAfter') END) COLLATE "C"`;
  // Whole calendar days from today's start (UTC): `now + days + 1` covers the first stage.
  const windowEnd = new Date(now.getTime() + (SECRET_WARNING_DAYS + 1) * DAY_MS).toISOString();
  const rows = await deps.providerDb
    .select({
      id: sources.id,
      tenantId: sources.tenantId,
      name: sources.name,
      ownApp: sql<OwnAppExpiryFacts | null>`${sources.config}->'ownApp'`,
    })
    .from(sources)
    .innerJoin(tenants, eq(tenants.id, sources.tenantId))
    .where(
      and(
        eq(sources.kind, "m365"),
        ne(sources.status, "disabled"),
        eq(tenants.status, "active"),
        sql`jsonb_typeof(${sources.config}->'ownApp') = 'object'`,
        sql`${expiresAt} is not null`,
        sql`${expiresAt} <= ${windowEnd}`,
        // Already reminded of the last stage for this very date: nothing left to raise.
        sql`(${sources.config}->'ownApp'->'expiryAlert'->>'stage' = 'expired'
          and ${sources.config}->'ownApp'->'expiryAlert'->>'expiresAt' = ${expiresAt}) is not true`,
      ),
    )
    .orderBy(expiresAt, sources.id)
    .limit(options.limit ?? MAX_SOURCES_PER_PASS);
  let alerts = 0;
  for (const row of rows) {
    if (!sourceAppAlertDue(row.ownApp, now)) {
      continue;
    }
    const raised = await withTenantTx(deps.db, row.tenantId, async (tx) => {
      // Read again under a row lock: a rotation or an edited date in the meantime wins.
      const [current] = await tx
        .select({
          name: sources.name,
          ownApp: sql<OwnAppExpiryFacts | null>`${sources.config}->'ownApp'`,
        })
        .from(sources)
        .where(eq(sources.id, row.id))
        .for("update");
      const ownApp = current?.ownApp;
      const due = ownApp ? sourceAppAlertDue(ownApp, now) : null;
      if (!current || !ownApp || !due) {
        return false;
      }
      await raiseEvents(
        tx,
        [sourceAppNotification({ ...row, name: current.name }, ownApp, due, now)],
        now,
      );
      const mark: SecretExpiryAlertMark = {
        expiresAt: due.expiresAt,
        stage: due.stage,
        at: now.toISOString(),
      };
      await tx
        .update(sources)
        .set({
          config: sql`jsonb_set(${sources.config}, '{ownApp,expiryAlert}', ${JSON.stringify(mark)}::jsonb, true)`,
        })
        .where(eq(sources.id, row.id));
      return true;
    });
    if (raised) {
      alerts += 1;
    }
  }
  return alerts;
}
