import type {
  LoadedTenantRowDto,
  ProviderAlertDto,
  ProviderKpisDto,
  ProviderTenantRowDto,
  TenantStatus,
} from "../../../../apps/api/src/features/dashboard/dto.js";
import type { TenantSummaryDto } from "../../../../apps/api/src/routes/v1/status.js";

/**
 * The provider view's judgement of each tenant: one matrix row per tenant,
 * the alerts that follow from it and the provider-wide figures. Pure; the
 * figures are read one tenant at a time by loadProviderView in service.ts.
 */

/** No successful backup for this long while objects are protected: the tenant is stale. */
export const STALE_BACKUP_HOURS = 48;

const HOUR_MS = 60 * 60 * 1000;

export interface TenantIdentity {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
}

/** The tenant's figures as read in its own pinned transaction. */
export interface TenantHealthFacts {
  summary: TenantSummaryDto;
  failures24h: number;
  failuresPrevious24h: number;
  storageError: boolean;
}

/** The tenant's protected mailboxes and the cap agreed with its customer (from the mailbox usage). */
export interface TenantMailboxUsage {
  mailboxes: number;
  cap: number | null;
}

function newest(values: readonly (string | null)[]): string | null {
  return values.reduce<string | null>(
    (latest, value) => (value !== null && (latest === null || value > latest) ? value : latest),
    null,
  );
}

/**
 * A matrix row from the tenant's figures. Without figures (they could not be
 * read) the row says so and every figure is null, never an invented zero.
 */
export function tenantRow(
  tenant: TenantIdentity,
  facts: TenantHealthFacts | null,
  usage: TenantMailboxUsage,
): ProviderTenantRowDto {
  const base = {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    mailboxes: usage.mailboxes,
    mailboxCap: usage.cap,
  };
  if (!facts) {
    return {
      ...base,
      loaded: false,
      readiness: null,
      protectedObjects: null,
      unverified: null,
      noBackup: null,
      notRestorable: null,
      failures24h: null,
      failuresPrevious24h: null,
      lastBackupAt: null,
      physicalBytes: null,
      storageError: null,
    };
  }
  const { summary } = facts;
  return {
    ...base,
    loaded: true,
    readiness: summary.readiness.overall,
    protectedObjects: summary.objects.active,
    unverified: summary.readiness.unverified,
    noBackup: summary.readiness.noBackup,
    notRestorable: summary.readiness.red,
    failures24h: facts.failures24h,
    failuresPrevious24h: facts.failuresPrevious24h,
    lastBackupAt: newest([
      summary.lastSuccess.mail,
      summary.lastSuccess.onedrive,
      summary.lastSuccess.imap,
    ]),
    physicalBytes: summary.storage.physicalBytes,
    storageError: facts.storageError,
  };
}

/** Alerts for one tenant, most severe first. */
export function alertsFor(row: ProviderTenantRowDto, now: Date): ProviderAlertDto[] {
  const alert = (
    kind: ProviderAlertDto["kind"],
    severity: ProviderAlertDto["severity"],
    count: number | null,
    since: string | null = null,
  ): ProviderAlertDto => ({
    tenantId: row.id,
    tenantName: row.name,
    kind,
    severity,
    count,
    since,
  });

  if (!row.loaded) {
    return [alert("unavailable", "warning", null)];
  }
  const alerts: ProviderAlertDto[] = [];
  if (row.storageError) {
    alerts.push(alert("storage_error", "destructive", null));
  }
  if (row.notRestorable > 0) {
    alerts.push(alert("not_restorable", "destructive", row.notRestorable));
  }
  if (row.failures24h > 0) {
    alerts.push(alert("failed_jobs", "destructive", row.failures24h));
  }
  if (row.mailboxCap !== null && row.mailboxes > row.mailboxCap) {
    alerts.push(alert("over_cap", "warning", row.mailboxes - row.mailboxCap));
  }
  if (row.unverified > 0) {
    alerts.push(alert("unverified", "warning", row.unverified));
  }
  if (row.noBackup > 0) {
    alerts.push(alert("no_backup", "warning", row.noBackup));
  }
  if (
    row.protectedObjects > 0 &&
    row.lastBackupAt !== null &&
    now.getTime() - Date.parse(row.lastBackupAt) > STALE_BACKUP_HOURS * HOUR_MS
  ) {
    alerts.push(alert("stale_backup", "warning", null, row.lastBackupAt));
  }
  return alerts;
}

/** Every tenant's alerts: destructive before warning, then by tenant name (stable otherwise). */
export function providerAlerts(
  rows: readonly ProviderTenantRowDto[],
  now: Date,
): ProviderAlertDto[] {
  const rank = (alert: ProviderAlertDto) => (alert.severity === "destructive" ? 0 : 1);
  return rows
    .flatMap((row) => alertsFor(row, now))
    .map((alert, index) => ({ alert, index }))
    .sort(
      (a, b) =>
        rank(a.alert) - rank(b.alert) ||
        a.alert.tenantName.localeCompare(b.alert.tenantName) ||
        a.index - b.index,
    )
    .map(({ alert }) => alert);
}

/**
 * Provider-wide figures. Tenant figures are summed over the tenants that
 * could be read, and the ones left out are counted, so the page can say the
 * totals are incomplete instead of adding unknowns in as zeros.
 */
export function providerKpis(rows: readonly ProviderTenantRowDto[]): ProviderKpisDto {
  const loaded = rows.filter((row): row is LoadedTenantRowDto => row.loaded);
  const sum = (pick: (row: LoadedTenantRowDto) => number) =>
    loaded.reduce((total, row) => total + pick(row), 0);
  return {
    tenants: rows.length,
    suspendedTenants: rows.filter((row) => row.status === "suspended").length,
    unavailableTenants: rows.length - loaded.length,
    tenantsNotReady: loaded.filter((row) => row.readiness === "red").length,
    protectedObjects: sum((row) => row.protectedObjects),
    unverifiedObjects: sum((row) => row.unverified),
    failures24h: sum((row) => row.failures24h),
    failuresPrevious24h: sum((row) => row.failuresPrevious24h),
    mailboxes: rows.reduce((total, row) => total + row.mailboxes, 0),
    physicalBytes: sum((row) => row.physicalBytes),
  };
}
