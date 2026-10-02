import { describe, expect, it } from "vitest";
import type { LoadedTenantRowDto } from "../../../../apps/api/src/features/dashboard/dto.js";
import type { TenantSummaryDto } from "../../../../apps/api/src/routes/v1/status.js";
import {
  STALE_BACKUP_HOURS,
  alertsFor,
  providerAlerts,
  providerKpis,
  tenantRow,
} from "./health.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");

function summary(overrides: Partial<TenantSummaryDto> = {}): TenantSummaryDto {
  return {
    lastSuccess: {
      mail: "2026-09-23T08:00:00.000Z",
      onedrive: "2026-09-23T09:00:00.000Z",
      imap: null,
      archive: null,
    },
    objects: {
      total: 5,
      active: 4,
      excluded: 1,
      orphaned: 0,
      failed: 0,
      withItemFailures: 0,
      runningBackups: 0,
    },
    storage: { logicalBytes: 2000, physicalBytes: 800 },
    recoveryReadiness: "green",
    readiness: {
      total: 4,
      green: 4,
      yellow: 0,
      red: 0,
      unverified: 0,
      noBackup: 0,
      overdue: 0,
      overall: "green",
      lastCheckedAt: "2026-09-22T03:00:00.000Z",
      running: 0,
    },
    lastVerifyAt: "2026-09-22T03:00:00.000Z",
    archive: { chain: "not_verified", lastCaptureAt: null },
    ...overrides,
  } as TenantSummaryDto;
}

const tenant = (
  name: string,
  status: "active" | "suspended" = "active",
  kind: "customer" | "internal" = "customer",
) => ({
  id: `id-${name}`,
  name,
  slug: name.toLowerCase(),
  status,
  kind,
});

const HEALTHY = { failures24h: 0, failuresPrevious24h: 0, storageError: false };

function row(name: string, overrides: Partial<LoadedTenantRowDto> = {}): LoadedTenantRowDto {
  const built = tenantRow(
    tenant(name),
    { summary: summary(), ...HEALTHY },
    { mailboxes: 3, cap: null },
  );
  if (!built.loaded) {
    throw new Error("expected a loaded row");
  }
  return { ...built, ...overrides };
}

describe("tenant matrix rows", () => {
  it("takes readiness, unverified objects and the newest backup from the summary", () => {
    const unverified = summary({
      readiness: { ...summary().readiness, unverified: 2, green: 2, overall: "red" },
    });
    const result = tenantRow(
      tenant("Contoso"),
      { summary: unverified, failures24h: 1, failuresPrevious24h: 3, storageError: false },
      { mailboxes: 3, cap: 5 },
    );
    expect(result).toMatchObject({
      loaded: true,
      readiness: "red",
      unverified: 2,
      protectedObjects: 4,
      ready: 2,
      needsAttention: 0,
      notRestorable: 0,
      noBackup: 0,
      failures24h: 1,
      failuresPrevious24h: 3,
      lastBackupAt: "2026-09-23T09:00:00.000Z",
      mailboxes: 3,
      mailboxCap: 5,
      physicalBytes: 800,
    });
  });

  it("marks a tenant whose figures could not be read, keeping its licence count", () => {
    expect(tenantRow(tenant("Fabrikam"), null, { mailboxes: 7, cap: 10 })).toEqual({
      id: "id-Fabrikam",
      name: "Fabrikam",
      slug: "fabrikam",
      status: "active",
      kind: "customer",
      mailboxes: 7,
      mailboxCap: 10,
      loaded: false,
      // Unknown, never an invented zero.
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
      physicalBytes: null,
      storageError: null,
    });
  });
});

describe("provider alerts", () => {
  it("raises nothing for a healthy tenant", () => {
    expect(alertsFor(row("Contoso"), NOW)).toEqual([]);
  });

  it("flags unverified objects, failures, storage, caps and stale backups", () => {
    const kinds = alertsFor(
      row("Contoso", {
        unverified: 3,
        noBackup: 1,
        notRestorable: 2,
        failures24h: 4,
        storageError: true,
        mailboxes: 12,
        mailboxCap: 10,
        lastBackupAt: new Date(NOW.getTime() - (STALE_BACKUP_HOURS + 1) * 3_600_000).toISOString(),
      }),
      NOW,
    ).map((alert) => [alert.kind, alert.severity, alert.count]);
    expect(kinds).toEqual([
      ["storage_error", "destructive", null],
      ["not_restorable", "destructive", 2],
      ["failed_jobs", "destructive", 4],
      ["over_cap", "warning", 2],
      ["unverified", "warning", 3],
      ["no_backup", "warning", 1],
      ["stale_backup", "warning", null],
    ]);
  });

  it("reports a tenant it could not read instead of skipping it", () => {
    const unread = tenantRow(tenant("Contoso"), null, { mailboxes: 12, cap: 10 });
    expect(alertsFor(unread, NOW)).toEqual([
      expect.objectContaining({ kind: "unavailable", tenantName: "Contoso", count: null }),
    ]);
  });

  it("lists destructive alerts first, then by tenant name", () => {
    const alerts = providerAlerts(
      [
        row("Zeta", { failures24h: 1 }),
        row("Alpha", { unverified: 1 }),
        row("Beta", { notRestorable: 1 }),
      ],
      NOW,
    );
    expect(alerts.map((alert) => `${alert.tenantName}:${alert.kind}`)).toEqual([
      "Beta:not_restorable",
      "Zeta:failed_jobs",
      "Alpha:unverified",
    ]);
  });
});

describe("provider figures", () => {
  it("adds up the tenants and counts the ones that are not ready", () => {
    const kpis = providerKpis([
      row("Contoso", { unverified: 2, readiness: "red", failures24h: 1, failuresPrevious24h: 4 }),
      { ...row("Fabrikam"), status: "suspended" },
    ]);
    expect(kpis).toEqual({
      tenants: 2,
      suspendedTenants: 1,
      unavailableTenants: 0,
      tenantsNotReady: 1,
      readiness: { total: 10, green: 8, yellow: 0, red: 0, unverified: 2, noBackup: 0 },
      protectedObjects: 8,
      unverifiedObjects: 2,
      failures24h: 1,
      failuresPrevious24h: 4,
      mailboxes: 6,
      physicalBytes: 1600,
    });
  });

  it("sums the objects of every state, so the tile can show them across tenants", () => {
    const kpis = providerKpis([
      row("Contoso", {
        ready: 10,
        needsAttention: 2,
        notRestorable: 1,
        unverified: 3,
        noBackup: 1,
      }),
      row("Fabrikam", {
        ready: 5,
        needsAttention: 0,
        notRestorable: 2,
        unverified: 0,
        noBackup: 0,
      }),
    ]);
    expect(kpis.readiness).toEqual({
      total: 24,
      green: 15,
      yellow: 2,
      red: 3,
      unverified: 3,
      noBackup: 1,
    });
  });

  it("does not count the operator's own organisation as a customer", () => {
    const own = {
      ...row("Own", { readiness: "red", mailboxes: 4 }),
      kind: "internal" as const,
    };
    const kpis = providerKpis([
      own,
      row("Contoso", { readiness: "red" }),
      { ...row("Fabrikam"), status: "suspended" as const },
    ]);
    // Customers only: the own organisation is neither a tenant, a suspended one nor a tenant that is not ready.
    expect(kpis).toMatchObject({ tenants: 2, suspendedTenants: 1, tenantsNotReady: 1 });
    // Its objects, backups and storage are protected like any other: they are in the sums.
    expect(kpis).toMatchObject({ protectedObjects: 12, mailboxes: 10, physicalBytes: 2400 });
  });

  it("leaves unread tenants out of the sums and says how many are missing", () => {
    const unread = tenantRow(tenant("Tailspin"), null, { mailboxes: 5, cap: null });
    const kpis = providerKpis([row("Contoso", { failures24h: 2 }), unread]);
    expect(kpis).toMatchObject({
      tenants: 2,
      unavailableTenants: 1,
      tenantsNotReady: 0,
      protectedObjects: 4,
      failures24h: 2,
      physicalBytes: 800,
      // The mailbox count is known for every tenant.
      mailboxes: 8,
    });
  });
});
