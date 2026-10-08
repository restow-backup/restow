import type {
  LoadedTenantRowDto,
  ProviderAlertDto,
  ProviderKpisDto,
  ProviderTenantRowDto,
  TenantKind,
  TenantStatus,
} from "../../../../apps/api/src/features/dashboard/dto.js";
import type { GuestCountsDto } from "../../../../apps/api/src/features/pve/protection.js";
import type { EndpointCountsDto } from "../../../../apps/api/src/routes/v1/endpoints.js";
import type { TenantSummaryDto } from "../../../../apps/api/src/routes/v1/status.js";

/**
 * The provider view's judgement of each tenant: one matrix row per tenant,
 * the alerts that follow from it and the provider-wide figures. Pure; the
 * figures are read one tenant at a time by loadProviderView in service.ts.
 */

/**
 * No successful backup for this long while objects are protected: the tenant is stale. The bound
 * of a tenant follows the schedules of its jobs (`staleAfterHours` of its facts); this one applies
 * when the facts carry none.
 */
export const STALE_BACKUP_HOURS = 48;

const HOUR_MS = 60 * 60 * 1000;

export interface TenantIdentity {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  kind: TenantKind;
}

/** The tenant's figures as read in its own pinned transaction. */
export interface TenantHealthFacts {
  summary: TenantSummaryDto;
  failures24h: number;
  failuresPrevious24h: number;
  storageError: boolean;
  /** The tenant's servers and clients (GET /status `endpoints`); absent, the tenant has none. */
  machines?: Pick<
    EndpointCountsDto,
    "total" | "withoutJob" | "failedLastBackup" | "lastSuccessAt"
  > | null;
  /** The tenant's VMs and containers of Proxmox VE (GET /status `guests`); absent, it has none. */
  guests?: Pick<
    GuestCountsDto,
    "protected" | "withoutJob" | "failedLastBackup" | "lastSuccessAt"
  > | null;
  /** After how many hours without a successful backup the tenant reads as stale (by its schedules). */
  staleAfterHours?: number;
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
    kind: tenant.kind,
    mailboxes: usage.mailboxes,
    mailboxCap: usage.cap,
  };
  if (!facts) {
    return {
      ...base,
      loaded: false,
      readiness: null,
      protectedObjects: null,
      ready: null,
      needsAttention: null,
      notRestorable: null,
      unverified: null,
      noBackup: null,
      failures24h: null,
      failuresPrevious24h: null,
      lastBackupAt: null,
      staleAfterHours: null,
      machines: null,
      machinesWithoutJob: null,
      machinesFailed: null,
      guests: null,
      guestsWithoutJob: null,
      guestsFailed: null,
      physicalBytes: null,
      storageError: null,
    };
  }
  const { summary } = facts;
  const machines = facts.machines ?? null;
  const guests = facts.guests ?? null;
  return {
    ...base,
    loaded: true,
    readiness: summary.readiness.overall,
    protectedObjects: summary.objects.active,
    ready: summary.readiness.green,
    needsAttention: summary.readiness.yellow,
    notRestorable: summary.readiness.red,
    unverified: summary.readiness.unverified,
    noBackup: summary.readiness.noBackup,
    failures24h: facts.failures24h,
    failuresPrevious24h: facts.failuresPrevious24h,
    lastBackupAt: newest([
      summary.lastSuccess.mail,
      summary.lastSuccess.onedrive,
      summary.lastSuccess.imap,
      machines?.lastSuccessAt ?? null,
      guests?.lastSuccessAt ?? null,
    ]),
    staleAfterHours: facts.staleAfterHours ?? STALE_BACKUP_HOURS,
    machines: machines ? machines.total - machines.withoutJob : 0,
    machinesWithoutJob: machines?.withoutJob ?? 0,
    machinesFailed: machines?.failedLastBackup ?? 0,
    guests: guests?.protected ?? 0,
    guestsWithoutJob: guests?.withoutJob ?? 0,
    guestsFailed: guests?.failedLastBackup ?? 0,
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
  if (row.machinesFailed > 0) {
    alerts.push(alert("machine_backup_failed", "destructive", row.machinesFailed));
  }
  if (row.guestsFailed > 0) {
    alerts.push(alert("guest_backup_failed", "destructive", row.guestsFailed));
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
  if (row.machinesWithoutJob > 0) {
    alerts.push(alert("machines_without_job", "warning", row.machinesWithoutJob));
  }
  if (row.guestsWithoutJob > 0) {
    alerts.push(alert("guests_without_job", "warning", row.guestsWithoutJob));
  }
  if (row.needsAttention > 0) {
    // Proven restorable with gaps, or a rating that is overdue: not "secured and checked".
    alerts.push(alert("needs_attention", "warning", row.needsAttention));
  }
  const protects = row.protectedObjects + row.machines + row.guests > 0;
  if (
    protects &&
    row.lastBackupAt !== null &&
    now.getTime() - Date.parse(row.lastBackupAt) > row.staleAfterHours * HOUR_MS
  ) {
    alerts.push(alert("stale_backup", "warning", row.staleAfterHours, row.lastBackupAt));
  }
  if (
    !protects &&
    row.machinesWithoutJob === 0 &&
    row.guestsWithoutJob === 0 &&
    row.status === "active" &&
    row.kind !== "internal"
  ) {
    // A customer that protects nothing is not "secured": say so instead of staying silent.
    alerts.push(alert("nothing_protected", "warning", null));
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
 *
 * The operator's own organisation (`kind = internal`) is protected like any
 * other tenant, so its objects, failures and storage are part of the sums, but
 * it is not one of the provider's customers: the tenant counts leave it out.
 */
export function providerKpis(rows: readonly ProviderTenantRowDto[]): ProviderKpisDto {
  const loaded = rows.filter((row): row is LoadedTenantRowDto => row.loaded);
  const customers = rows.filter((row) => row.kind !== "internal");
  const sum = (pick: (row: LoadedTenantRowDto) => number) =>
    loaded.reduce((total, row) => total + pick(row), 0);
  return {
    tenants: customers.length,
    suspendedTenants: customers.filter((row) => row.status === "suspended").length,
    unavailableTenants: rows.length - loaded.length,
    tenantsNotReady: customers.filter((row) => row.loaded && row.readiness === "red").length,
    readiness: {
      total: sum(
        (row) => row.ready + row.needsAttention + row.notRestorable + row.unverified + row.noBackup,
      ),
      green: sum((row) => row.ready),
      yellow: sum((row) => row.needsAttention),
      red: sum((row) => row.notRestorable),
      unverified: sum((row) => row.unverified),
      noBackup: sum((row) => row.noBackup),
    },
    protectedObjects: sum((row) => row.protectedObjects),
    unverifiedObjects: sum((row) => row.unverified),
    failures24h: sum((row) => row.failures24h),
    failuresPrevious24h: sum((row) => row.failuresPrevious24h),
    mailboxes: rows.reduce((total, row) => total + row.mailboxes, 0),
    physicalBytes: sum((row) => row.physicalBytes),
  };
}
