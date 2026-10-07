import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import en from "@restow/i18n/resources/en/dashboard.json" with { type: "json" };

import { i18n } from "@/i18n";

import type { TenantWidgets, WidgetData, WidgetResult } from "./api.js";
import { WidgetUnavailableError, type WidgetView } from "./presenters.js";
import { DashboardWidgets, PAGE_WIDGETS, expectedWidgets } from "./widget-registry.js";
import { EndpointsWidget } from "./widgets/endpoints-widget.js";
import { LastBackupWidget } from "./widgets/last-backup-widget.js";
import { ReadinessWidget } from "./widgets/readiness-widget.js";
import { RecentJobsWidget } from "./widgets/recent-jobs-widget.js";
import { RetentionWidget } from "./widgets/retention-widget.js";
import {
  MailboxUsageWidget,
  ProtectedObjectsWidget,
  StorageWidget,
} from "./widgets/tile-widgets.js";
import {
  BackupSuccessTile,
  BackupTrendWidget,
  EstimateSwatch,
  StorageGrowthWidget,
  StoredSwatch,
  VerificationHistoryWidget,
} from "./widgets/trend-widgets.js";

/**
 * Every widget rendered to static markup (no DOM needed) in its four states:
 * loading skeleton, failed with a retry, empty with its reason, and with data.
 * Router links become plain anchors so widgets render outside a router.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      className,
      children,
    }: {
      to: string;
      search?: Record<string, string>;
      className?: string;
      children: React.ReactNode;
    }) => {
      const query = new URLSearchParams(search ?? {}).toString();
      return (
        <a href={query ? `${to}?${query}` : to} className={className}>
          {children}
        </a>
      );
    },
  };
});

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

/** Top-level groups of the namespace; a key path in the markup means a missing translation. */
const KEY_GROUPS = Object.entries(en)
  .filter(([, value]) => typeof value === "object")
  .map(([key]) => key);

function expectTranslated(html: string): void {
  for (const group of KEY_GROUPS) {
    expect(html).not.toMatch(new RegExp(`[>"]${group}\\.[a-zA-Z_]+`));
  }
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const loading = { kind: "loading" } as const;
const failed = { kind: "error", error: new WidgetUnavailableError() } as const;
const ready = <T,>(data: T): WidgetView<T> => ({ kind: "ready", data });
const state = { onRetry: () => {}, retrying: false };

function expectLoading(html: string) {
  expect(html).toContain('data-state="loading"');
  expect(html).toContain('data-slot="skeleton"');
}

function expectFailed(html: string) {
  expect(html).toContain('data-state="error"');
  expect(html).toContain('role="alert"');
  expect(html).toContain("This part could not be loaded");
  expect(html).toContain("Retry");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAYS = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2026, 7, 1) + index * 86_400_000).toISOString().slice(0, 10);
    return date;
  });

const data: WidgetData = {
  setup: {
    complete: false,
    done: 5,
    total: 7,
    items: [
      { id: "storage", state: "done", reason: null, actionable: true },
      { id: "source", state: "done", reason: null, actionable: true },
      { id: "objects", state: "done", reason: null, actionable: true },
      { id: "schedules", state: "open", reason: "no_backup_schedule", actionable: true },
      { id: "firstBackup", state: "done", reason: null, actionable: true },
      { id: "firstVerification", state: "done", reason: null, actionable: true },
      { id: "notificationMail", state: "attention", reason: "test_failed", actionable: false },
    ],
  },
  lastBackup: {
    lastSuccess: {
      mail: new Date(Date.now() - 3_600_000).toISOString(),
      onedrive: null,
      imap: null,
      archive: null,
    },
    protectedKinds: { mailbox: 4, onedrive: 2, imap: 0 },
    machines: { protected: 0, withoutJob: 0, lastSuccessAt: null },
    staleAfterHours: { mail: 48, machines: 48 },
  },
  readiness: {
    overall: "red",
    total: 6,
    green: 3,
    yellow: 0,
    red: 0,
    unverified: 2,
    noBackup: 1,
    overdue: 0,
    withoutJob: 0,
    running: 1,
    lastCheckedAt: new Date(Date.now() - 7_200_000).toISOString(),
  },
  protectedObjects: {
    total: 7,
    active: 6,
    excluded: 1,
    orphaned: 0,
    failed: 1,
    withItemFailures: 2,
    runningBackups: 0,
    machines: { protected: 0, withoutJob: 0, failedLastBackup: 0 },
    noBackup: 0,
  },
  storage: {
    logicalBytes: 4_000_000_000,
    physicalBytes: 1_000_000_000,
    target: { source: "tenant", status: "error" },
  },
  mailboxUsage: {
    scope: "installation",
    used: 12,
    tenant: { used: 12, cap: null },
  },
  endpoints: {
    protected: 6,
    machines: 6,
    withoutJob: 0,
    servers: 4,
    clients: 2,
    readiness: { green: 3, yellow: 0, red: 1, unverified: 1, noBackup: 1 },
    notReady: 3,
    failedLastBackup: 1,
    needingAttention: 3,
    otherAttention: 3,
    lastSuccessAt: new Date(Date.now() - 7_200_000).toISOString(),
  },
  backupTrend: {
    days: 60,
    series: DAYS(60).map((date, index) => ({
      date,
      succeeded: index % 2,
      withItemFailures: index % 5 === 0 ? 1 : 0,
      failed: index % 7 === 0 ? 1 : 0,
    })),
  },
  verificationHistory: {
    days: 30,
    series: DAYS(30).map((date, index) => ({ date, green: index % 3, yellow: 0, red: 0 })),
    lastCheckedAt: new Date().toISOString(),
  },
  storageGrowth: {
    days: 30,
    series: DAYS(30).map((date, index) => ({ date, bytes: 1000 + index * 100 })),
    growthBytes: 2900,
    forecast: {
      method: "linear",
      basisDays: 30,
      slopeBytesPerDay: 100,
      points: [{ date: "2026-09-01", bytes: 4000 }],
    },
  },
  retention: {
    policy: null,
    scopedPolicies: 0,
    activeHolds: 1,
    snapshots: { active: 40, pruned: 0, oldestAt: "2026-08-01T00:00:00.000Z" },
    lastRun: null,
  },
  recentJobs: {
    items: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        queue: "backup",
        status: "completed",
        object: { kind: "mailbox", displayName: "Anna Example" },
        createdAt: "2026-09-23T08:00:00.000Z",
        startedAt: "2026-09-23T08:00:00.000Z",
        completedAt: "2026-09-23T08:10:00.000Z",
        progress: { total: 10, done: 8, failed: 2 },
        throttledUntil: null,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        queue: "backup",
        status: "active",
        object: { kind: "onedrive", displayName: null },
        createdAt: "2026-09-23T09:00:00.000Z",
        startedAt: "2026-09-23T09:00:00.000Z",
        completedAt: null,
        progress: { total: 100, done: 10, failed: 0 },
        throttledUntil: "2099-01-01T00:00:00.000Z",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        queue: "backup",
        status: "failed",
        object: { kind: "mailbox", displayName: "Bernd Beispiel" },
        createdAt: "2026-09-23T07:00:00.000Z",
        startedAt: "2026-09-23T07:00:00.000Z",
        completedAt: "2026-09-23T07:02:00.000Z",
        progress: { total: 10, done: 0, failed: 0 },
        throttledUntil: null,
        failure: {
          code: "graph.mailbox_not_licensed",
          category: "microsoft",
          transient: false,
          retryable: true,
          params: { reason: "not_enabled" },
          technical: { httpStatus: 404 },
          occurredAt: "2026-09-23T07:02:00.000Z",
          step: "enumerate",
          retry: null,
          steps: [],
          docsUrl: "https://docs.example.test/troubleshooting/",
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

describe("recovery readiness", () => {
  it("flags unverified backups visibly and never in a success tone", () => {
    const html = render(<ReadinessWidget view={ready(data.readiness)} {...state} canAdminister />);
    expectTranslated(html);
    expect(html).toContain('data-flag="unverified"');
    expect(html).toContain("2 backups not verified yet");
    expect(html).toContain('data-segment="unverified"');
    expect(html).toContain("1 object without a backup");
    expect(html).toContain("Not ready");
    // The alert's button leads to the unverified objects.
    expect(html).toContain('href="/verify?state=unverified"');
    const flag = html.slice(
      html.indexOf('data-flag="unverified"') - 200,
      html.indexOf('data-flag="unverified"'),
    );
    expect(flag).not.toContain("success");
  });

  it("links every legend row that has objects to the table of exactly those objects", () => {
    // 3 green, 0 yellow, 2 red, 2 unverified, 1 without a backup.
    const html = render(
      <ReadinessWidget view={ready({ ...data.readiness, red: 2 })} {...state} canAdminister />,
    );
    const row = (segment: string) => {
      const start = html.indexOf(`data-segment="${segment}"`);
      return html.slice(start, html.indexOf("</li>", start));
    };
    expect(row("green")).toContain('href="/verify?state=green"');
    expect(row("red")).toContain('href="/verify?state=red"');
    expect(row("unverified")).toContain('href="/verify?state=unverified"');
    expect(row("noBackup")).toContain('href="/verify?state=no_backup"');
    // A row with none is plain text: shown, with its 0, but not a link.
    expect(row("yellow")).not.toContain("href=");
    expect(row("yellow")).toContain(">0<");
    // In the order of the readiness page's filter: ready, attention, cannot be restored ...
    const order = ["green", "yellow", "red", "unverified", "noBackup"].map((key) =>
      html.indexOf(`data-segment="${key}"`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((position) => position > 0)).toBe(true);
  });

  it("gives a plain member the legend as text, with no link to a page they cannot open", () => {
    const html = render(
      <ReadinessWidget view={ready(data.readiness)} {...state} canAdminister={false} />,
    );
    expect(html).toContain('data-segment="red"');
    expect(html).not.toContain('href="/verify');
    expect(html).not.toContain("Every row opens the table");
  });

  it("has skeleton, error and empty states", () => {
    expectLoading(render(<ReadinessWidget view={loading} {...state} canAdminister />));
    expectFailed(render(<ReadinessWidget view={failed} {...state} canAdminister />));
    const empty = render(
      <ReadinessWidget
        view={ready({ ...data.readiness, total: 0, green: 0, unverified: 0, noBackup: 0 })}
        {...state}
        canAdminister={false}
      />,
    );
    expect(empty).toContain('data-state="empty"');
    expect(empty).toContain("Nothing to rate yet");
    // A plain member gets no link to a page they cannot open.
    expect(empty).not.toContain('href="/protected-objects"');
  });
});

describe("servers and clients", () => {
  it("says in plain words how many machines are protected and what is not proven", () => {
    const html = render(<EndpointsWidget view={ready(data.endpoints)} {...state} />);
    expectTranslated(html);
    expect(html).toContain('data-widget="endpoints"');
    expect(html).toContain("Servers and clients");
    expect(html).toContain("6 machines protected (4 servers, 2 clients in total).");
    expect(html).toContain("3 machines not proven restorable");
    expect(html).toContain("1 machine: the last backup failed");
    expect(html).toContain("3 machines need attention");
    expect(html).toContain("Last backup");
    expect(html).toContain("<time");
    expect(html).toContain('href="/inventory"');
  });

  it("colours the machines by the rules of the readiness card", () => {
    const html = render(<EndpointsWidget view={ready(data.endpoints)} {...state} />);
    // Anything not proven restorable is "Not ready", in the destructive tone, as for the objects.
    expect(html).toContain("Not ready");
    expect(html).toMatch(/data-tone="destructive"[^>]*><svg[\s\S]*?<\/svg>Not ready/);
    expect(html).toMatch(/data-segment="red"/);
    expect(html).toMatch(/data-segment="noBackup"/);
    expect(html).toMatch(/data-segment="unverified"/);
    expect(html).toMatch(/data-segment="green"/);
    expect(html).not.toContain('data-segment="yellow"');
    // The failures carry the destructive tone, the look-at-it finding the warning tone.
    expect(html).toMatch(/data-finding="notReady"[^>]*><span[^>]*data-tone="destructive"/);
    expect(html).toMatch(/data-finding="failedLastBackup"[^>]*><span[^>]*data-tone="destructive"/);
    expect(html).toMatch(/data-finding="attention"[^>]*><span[^>]*data-tone="warning"/);
  });

  it("reports a healthy fleet as ready, with no finding and no success claim it cannot back", () => {
    const html = render(
      <EndpointsWidget
        view={ready({
          ...data.endpoints,
          readiness: { green: 6, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
          notReady: 0,
          failedLastBackup: 0,
          needingAttention: 0,
          otherAttention: 0,
        })}
        {...state}
      />,
    );
    expect(html).toContain("Ready");
    expect(html).toContain('data-flag="all-good"');
    expect(html).toContain("Every machine is proven restorable and its last backup succeeded.");
    expect(html).not.toContain("data-finding");
  });

  it("says when no backup succeeded yet, and speaks of one machine in the singular", () => {
    const html = render(
      <EndpointsWidget
        view={ready({
          protected: 1,
          machines: 1,
          withoutJob: 0,
          servers: 1,
          clients: 0,
          readiness: { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 1 },
          notReady: 1,
          failedLastBackup: 0,
          needingAttention: 0,
          otherAttention: 0,
          lastSuccessAt: null,
        })}
        {...state}
      />,
    );
    expect(html).toContain("No successful backup yet");
    expect(html).toContain("1 machine protected (1 server, 0 clients in total).");
    expect(html).toContain("1 machine not proven restorable");
  });

  it("speaks German too, with the same counts", async () => {
    await i18n.changeLanguage("de");
    try {
      const html = render(<EndpointsWidget view={ready(data.endpoints)} {...state} />);
      expect(html).toContain("Server und Clients");
      expect(html).toContain("6 Rechner geschützt (4 Server, 2 Clients insgesamt).");
      expect(html).toContain("3 Rechner nicht nachweislich wiederherstellbar");
      expect(html).toContain("1 Rechner: letzte Sicherung fehlgeschlagen");
      expect(html).toContain("3 Rechner brauchen Aufmerksamkeit");
      expect(html).toContain("Nicht bereit");
      expect(html).toContain("Letzte Sicherung");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("has skeleton and error states", () => {
    expectLoading(render(<EndpointsWidget view={loading} {...state} />));
    expectFailed(render(<EndpointsWidget view={failed} {...state} />));
  });
});

describe("last backup", () => {
  it("lists protected types only and says when one never succeeded", () => {
    const html = render(
      <LastBackupWidget view={ready(data.lastBackup)} {...state} canAdminister />,
    );
    expectTranslated(html);
    expect(html).toContain('data-type="mail"');
    expect(html).toContain('data-type="onedrive"');
    expect(html).not.toContain('data-type="imap"');
    expect(html).toContain("No successful backup yet");
    expect(html).toContain("<time");
  });

  it("has skeleton, error and empty states", () => {
    expectLoading(render(<LastBackupWidget view={loading} {...state} canAdminister />));
    expectFailed(render(<LastBackupWidget view={failed} {...state} canAdminister />));
    const empty = render(
      <LastBackupWidget
        view={ready({
          lastSuccess: { mail: null, onedrive: null, imap: null, archive: null },
          protectedKinds: { mailbox: 0, onedrive: 0, imap: 0 },
          machines: { protected: 0, withoutJob: 0, lastSuccessAt: null },
          staleAfterHours: { mail: 48, machines: 48 },
        })}
        {...state}
        canAdminister
      />,
    );
    expect(empty).toContain('data-state="empty"');
    expect(empty).toContain("No backups yet");
    expect(empty).toContain('href="/sources"');
  });
});

describe("machines on the status tab", () => {
  it("lists servers and clients as a type of their own and judges them by their schedule", () => {
    const html = render(
      <LastBackupWidget
        view={ready({
          ...data.lastBackup,
          protectedKinds: { mailbox: 0, onedrive: 0, imap: 0 },
          lastSuccess: { mail: null, onedrive: null, imap: null, archive: null },
          machines: {
            protected: 2,
            withoutJob: 0,
            lastSuccessAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
          },
          staleAfterHours: { mail: 48, machines: 336 },
        })}
        {...state}
        canAdminister
      />,
    );
    expect(html).toContain('data-type="machines"');
    expect(html).toContain("Servers and clients");
    // Weekly: five days old is not stale yet.
    expect(html).not.toContain("Older than");
    const daily = render(
      <LastBackupWidget
        view={ready({
          ...data.lastBackup,
          machines: {
            protected: 1,
            withoutJob: 0,
            lastSuccessAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
          },
        })}
        {...state}
        canAdminister
      />,
    );
    expect(daily).toContain("Older than 2 days");
  });

  it("counts machines in a job as protected and never says 'no failures' without runs", () => {
    const html = render(
      <ProtectedObjectsWidget
        view={ready({
          ...data.protectedObjects,
          active: 0,
          failed: 0,
          withItemFailures: 0,
          machines: { protected: 3, withoutJob: 1, failedLastBackup: 0 },
          noBackup: 2,
        })}
        {...state}
        canAdminister
      />,
    );
    expect(html).not.toContain('data-state="empty"');
    expect(html).toContain("including 3 machines");
    expect(html).toContain("2 without a backup");
    expect(html).toContain("1 machine in no backup job");
    expect(html).not.toContain("No failures in the latest runs");
  });

  it("flags machines in no backup job on the readiness card", () => {
    const html = render(
      <ReadinessWidget
        view={ready({ ...data.readiness, withoutJob: 2, overall: "yellow" as const })}
        {...state}
        canAdminister
      />,
    );
    expectTranslated(html);
    expect(html).toContain('data-flag="without-job"');
    expect(html).toContain("2 machines in no backup job");
    expect(html).toContain('href="/inventory"');
    // The red box of objects without a backup has a way to them, too.
    expect(html).toContain('href="/verify?state=no_backup"');
  });
});

describe("VMs and containers on the status tab", () => {
  it("lists them as a type of their own, judged by the PVE jobs' schedules", () => {
    const html = render(
      <LastBackupWidget
        view={ready({
          lastSuccess: { mail: null, onedrive: null, imap: null, archive: null },
          protectedKinds: { mailbox: 0, onedrive: 0, imap: 0 },
          machines: { protected: 0, withoutJob: 0, lastSuccessAt: null },
          guests: {
            protected: 2,
            withoutJob: 0,
            lastSuccessAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          },
          staleAfterHours: { mail: 48, machines: 48, guests: 48 },
        })}
        {...state}
        canAdminister
      />,
    );
    expectTranslated(html);
    expect(html).not.toContain('data-state="empty"');
    expect(html).toContain('data-type="guests"');
    expect(html).toContain("VMs and containers");
    expect(html).not.toContain('data-type="machines"');
    expect(html).toContain("Older than 2 days");
  });

  it("is not 'nothing protected' while only guests exist, and counts their failures and missing jobs", () => {
    const html = render(
      <ProtectedObjectsWidget
        view={ready({
          ...data.protectedObjects,
          active: 0,
          failed: 0,
          withItemFailures: 0,
          machines: { protected: 0, withoutJob: 0, failedLastBackup: 0 },
          guests: { protected: 3, withoutJob: 2, failedLastBackup: 1, restorePoints: 12 },
          noBackup: 0,
        })}
        {...state}
        canAdminister
      />,
    );
    expectTranslated(html);
    expect(html).not.toContain('data-state="empty"');
    expect(html).toContain("including 3 VMs and containers");
    expect(html).toContain("1 failed");
    expect(html).toContain("2 guests in no backup job");
    expect(html).not.toContain("No failures in the latest runs");
    // Guests found by the inventory but in no job: still not "nothing protected yet".
    const unjobbed = render(
      <ProtectedObjectsWidget
        view={ready({
          ...data.protectedObjects,
          active: 0,
          machines: { protected: 0, withoutJob: 0, failedLastBackup: 0 },
          guests: { protected: 0, withoutJob: 1, failedLastBackup: 0, restorePoints: 0 },
        })}
        {...state}
        canAdminister
      />,
    );
    expect(unjobbed).not.toContain('data-state="empty"');
  });

  it("flags guests that left every backup job on the readiness card", () => {
    const html = render(
      <ReadinessWidget
        view={ready({ ...data.readiness, guestsWithoutJob: 1, overall: "yellow" as const })}
        {...state}
        canAdminister
      />,
    );
    expectTranslated(html);
    expect(html).toContain('data-flag="guests-without-job"');
    expect(html).toContain("1 guest in no backup job");
    expect(html).toContain('href="/virtualization"');
  });
});

describe("key figures", () => {
  it("shows protected objects with failures apart from runs that left items", () => {
    const html = render(
      <ProtectedObjectsWidget view={ready(data.protectedObjects)} {...state} canAdminister />,
    );
    expectTranslated(html);
    expect(html).toContain("tabular-nums");
    expect(html).toContain("1 failed");
    expect(html).toContain("2 with failed items");
    expect(html).not.toContain("No failures in the latest runs");
    expectLoading(render(<ProtectedObjectsWidget view={loading} {...state} canAdminister />));
    expectFailed(render(<ProtectedObjectsWidget view={failed} {...state} canAdminister />));
    const empty = render(
      <ProtectedObjectsWidget
        view={ready({ ...data.protectedObjects, active: 0 })}
        {...state}
        canAdminister
      />,
    );
    expect(empty).toContain('data-state="empty"');
    expect(empty).toContain("Nothing protected yet");
  });

  it("says a protected object without failures is in order, in a neutral tone, never green", () => {
    const html = render(
      <ProtectedObjectsWidget
        view={ready({ ...data.protectedObjects, failed: 0, withItemFailures: 0 })}
        {...state}
        canAdminister
      />,
    );
    expect(html).toContain("No failures in the latest runs");
    expect(html).toContain('data-tone="neutral"');
    // Green means a passed restore check; a backup without failures is not one.
    expect(html).not.toContain('data-tone="success"');
    expect(html).not.toContain("text-success");
  });

  it("shows stored bytes and a failing repository", () => {
    const html = render(<StorageWidget view={ready(data.storage)} {...state} canAdminister />);
    expectTranslated(html);
    expect(html).toContain("75% saved by deduplication");
    expect(html).toContain("Repository failing");
    expectLoading(render(<StorageWidget view={loading} {...state} canAdminister />));
    expectFailed(render(<StorageWidget view={failed} {...state} canAdminister />));
    const empty = render(
      <StorageWidget
        view={ready({
          logicalBytes: 0,
          physicalBytes: 0,
          target: { source: "installation_default", status: "ok" },
        })}
        {...state}
        canAdminister
      />,
    );
    expect(empty).toContain("Nothing stored yet");
  });

  it("shows the protected mailboxes without an edition, a limit or a license link", () => {
    const installation = render(
      <MailboxUsageWidget view={ready(data.mailboxUsage)} {...state} isProviderAdmin />,
    );
    expectTranslated(installation);
    expect(installation).toContain('data-widget="mailboxUsage"');
    expect(installation).toContain("Protected mailboxes");
    expect(installation).toContain(">12<");
    expect(installation).not.toMatch(/limit|allowance|Unlimited|edition|Community|licen/i);
    expect(installation).not.toContain('href="/license"');
    // A provider admin gets the tenant list, which breaks the number down per tenant.
    expect(installation).toContain('href="/tenants"');
    expect(installation).toContain("Usage per tenant");

    const provider = render(
      <MailboxUsageWidget
        view={ready({ ...data.mailboxUsage, used: 4000 })}
        {...state}
        isProviderAdmin
      />,
    );
    expect(provider).toContain("4,000");
    expect(provider).not.toMatch(/limit|allowance|Unlimited/i);

    const tenantAdmin = render(
      <MailboxUsageWidget
        view={ready({
          ...data.mailboxUsage,
          scope: "tenant",
          used: 7,
          tenant: { used: 7, cap: 5 },
        })}
        {...state}
        isProviderAdmin={false}
      />,
    );
    expect(tenantAdmin).toContain("Mailboxes in this tenant");
    expect(tenantAdmin).toContain("Cap agreed for this tenant: 5");
    expect(tenantAdmin).not.toContain('href="/tenants"');

    expectLoading(render(<MailboxUsageWidget view={loading} {...state} isProviderAdmin />));
    expectFailed(render(<MailboxUsageWidget view={failed} {...state} isProviderAdmin />));
    const empty = render(
      <MailboxUsageWidget
        view={ready({ ...data.mailboxUsage, used: 0 })}
        {...state}
        isProviderAdmin
      />,
    );
    expect(empty).toContain("No mailbox protected yet");
  });

  it("shows the backup success rate with its change", () => {
    const html = render(<BackupSuccessTile view={ready(data.backupTrend)} {...state} days={14} />);
    expectTranslated(html);
    expect(html).toContain("Backup success (14 days)");
    expect(html).toContain("vs. the 14 days before");
    expectLoading(render(<BackupSuccessTile view={loading} {...state} days={14} />));
    expectFailed(render(<BackupSuccessTile view={failed} {...state} days={14} />));
    const empty = render(
      <BackupSuccessTile view={ready({ days: 60, series: [] })} {...state} days={30} />,
    );
    expect(empty).toContain("No backup finished in the last 30 days.");
  });
});

describe("charts", () => {
  const trendProps = { days: 14 as const, onDaysChange: () => {}, canAdminister: true };

  it("plots backup runs by outcome with a legend-ready config and a period toggle", () => {
    const html = render(
      <BackupTrendWidget view={ready(data.backupTrend)} {...state} {...trendProps} />,
    );
    expectTranslated(html);
    expect(html).toContain('data-slot="chart"');
    // The status chart colours every page uses, never the UI tones (too light for a bar).
    // A completed backup is Lapis, not the green of a passed restore check.
    expect(html).toContain("--color-succeeded: var(--chart-info)");
    expect(html).not.toContain("--color-succeeded: var(--chart-success)");
    expect(html).toContain("--color-withItemFailures: var(--chart-warning)");
    expect(html).toContain("--color-failed: var(--chart-destructive)");
    expect(html).toContain("14 days");
    expect(html).toContain("30 days");
    expectLoading(render(<BackupTrendWidget view={loading} {...state} {...trendProps} />));
    const error = render(<BackupTrendWidget view={failed} {...state} {...trendProps} />);
    expect(error).toContain('data-state="error"');
    expect(error).toContain("Retry");
    const empty = render(
      <BackupTrendWidget view={ready({ days: 60, series: [] })} {...state} {...trendProps} />,
    );
    expect(empty).toContain('data-state="empty"');
    expect(empty).toContain('href="/backup"');
  });

  it("plots restore checks and says when the last one ran", () => {
    const html = render(
      <VerificationHistoryWidget view={ready(data.verificationHistory)} {...state} canAdminister />,
    );
    expectTranslated(html);
    expect(html).toContain('data-slot="chart"');
    expect(html).toContain("Last check");
    // The same colours as the readiness chart on the Statistics page.
    expect(html).toContain("--color-green: var(--chart-success)");
    expect(html).toContain("--color-yellow: var(--chart-warning)");
    expect(html).toContain("--color-red: var(--chart-destructive)");
    expectLoading(render(<VerificationHistoryWidget view={loading} {...state} canAdminister />));
    expect(render(<VerificationHistoryWidget view={failed} {...state} canAdminister />)).toContain(
      'data-state="error"',
    );
    const empty = render(
      <VerificationHistoryWidget
        view={ready({ days: 30, series: [], lastCheckedAt: null })}
        {...state}
        canAdminister
      />,
    );
    expect(empty).toContain("No restore checks yet");
  });

  it("labels the storage forecast as an estimate", () => {
    const html = render(<StorageGrowthWidget view={ready(data.storageGrowth)} {...state} />);
    expectTranslated(html);
    expect(html).toContain("Estimate: about");
    expect(html).toContain("--color-forecast: var(--chart-1)");
    // The basis of the straight line comes from the response, not from the text.
    expect(html).toContain("straight line through the last 30 days");
    const shortBasis = render(
      <StorageGrowthWidget
        view={ready({
          ...data.storageGrowth,
          forecast: data.storageGrowth.forecast && {
            ...data.storageGrowth.forecast,
            basisDays: 12,
          },
        })}
        {...state}
      />,
    );
    expect(shortBasis).toContain("straight line through the last 12 days");
    const without = render(
      <StorageGrowthWidget view={ready({ ...data.storageGrowth, forecast: null })} {...state} />,
    );
    expect(without).toContain("No estimate");
    expectLoading(render(<StorageGrowthWidget view={loading} {...state} />));
    expect(render(<StorageGrowthWidget view={failed} {...state} />)).toContain(
      'data-state="error"',
    );
    const empty = render(
      <StorageGrowthWidget
        view={ready({
          days: 30,
          series: [{ date: "2026-09-23", bytes: 0 }],
          growthBytes: 0,
          forecast: null,
        })}
        {...state}
      />,
    );
    expect(empty).toContain("Nothing stored yet");
  });

  it("draws the estimate's legend marker dashed and the measured one solid", () => {
    const estimate = render(<EstimateSwatch />);
    expect(estimate).toContain('stroke="var(--color-forecast)"');
    expect(estimate).toContain("stroke-dasharray");
    const stored = render(<StoredSwatch />);
    expect(stored).toContain('stroke="var(--color-stored)"');
    expect(stored).not.toContain("stroke-dasharray");
  });
});

describe("retention", () => {
  it("says honestly that everything is kept without a policy", () => {
    const html = render(<RetentionWidget view={ready(data.retention)} {...state} />);
    expectTranslated(html);
    expect(html).toContain("No policy");
    expect(html).toContain("Everything is kept: there is no retention policy yet");
    expect(html).toContain("1 legal hold pauses pruning");
    expect(html).toContain("Not run yet");
  });

  it("describes a policy", () => {
    const html = render(
      <RetentionWidget
        view={ready({ ...data.retention, policy: { name: "Quarter", keepDays: 90, keepLast: 3 } })}
        {...state}
      />,
    );
    expect(html).toContain("Policy: Quarter");
    expect(html).toContain("older than 90 days are pruned");
    expect(html).toContain("the newest 3 restore points");
  });

  it("has skeleton, error and empty states", () => {
    expectLoading(render(<RetentionWidget view={loading} {...state} />));
    expectFailed(render(<RetentionWidget view={failed} {...state} />));
    const empty = render(
      <RetentionWidget
        view={ready({ ...data.retention, snapshots: { active: 0, pruned: 0, oldestAt: null } })}
        {...state}
      />,
    );
    expect(empty).toContain("No restore points yet");
  });
});

describe("recent runs", () => {
  it("lists jobs with honest statuses", () => {
    const html = render(<RecentJobsWidget view={ready(data.recentJobs)} {...state} />);
    expectTranslated(html);
    expect(html).toContain("Completed with failures");
    expect(html).toContain("Waiting for Microsoft");
    // A throttled job says until when Microsoft asked it to wait.
    expect(html).toContain("data-throttled-until");
    expect(html).toContain("Resumes");
    expect(html).toContain('dateTime="2099-01-01T00:00:00.000Z"');
    expect(html).toContain("2 items failed");
    expect(html).toContain('href="/history/11111111-1111-4111-8111-111111111111"');
  });

  it("gives every failed job its reason in one line, never a bare red badge", () => {
    const html = render(<RecentJobsWidget view={ready(data.recentJobs)} {...state} />);
    expect(html).toContain("This user has no usable Exchange Online mailbox");
    expect(html).toContain('data-cause="graph.mailbox_not_licensed"');
  });

  it("has skeleton, error and empty states", () => {
    expectLoading(render(<RecentJobsWidget view={loading} {...state} />));
    expectFailed(render(<RecentJobsWidget view={failed} {...state} />));
    const empty = render(<RecentJobsWidget view={ready({ items: [] })} {...state} />);
    expect(empty).toContain("No runs yet");
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function ok<K extends keyof WidgetData>(id: K): WidgetResult<WidgetData[K]> {
  return { state: "ok", data: data[id] };
}

describe("widget registry", () => {
  const context = {
    onRetry: () => {},
    retrying: false,
    isProviderAdmin: false,
    trendDays: 14 as const,
    onTrendDaysChange: () => {},
  };

  it("renders exactly the widgets the response contains", () => {
    const memberWidgets: TenantWidgets = {
      setup: ok("setup"),
      readiness: ok("readiness"),
      lastBackup: ok("lastBackup"),
      protectedObjects: ok("protectedObjects"),
      storage: ok("storage"),
      retention: ok("retention"),
      backupTrend: ok("backupTrend"),
      verificationHistory: ok("verificationHistory"),
      storageGrowth: ok("storageGrowth"),
    };
    const html = render(
      <DashboardWidgets
        widgets={memberWidgets}
        loading={false}
        canAdminister={false}
        {...context}
      />,
    );
    expectTranslated(html);
    expect(html).not.toContain('data-widget="recentJobs"');
    expect(html).not.toContain('data-widget="mailboxUsage"');
    expect(html).toContain('data-widget="backupSuccess"');
    // The setup checklist is the sidebar's Start entry, not a card here, and nothing says "complete".
    expect(html).not.toContain('data-widget="setup"');
    expect(html).not.toContain("Setup complete");
    // Three figures for a member: no gap where the mailbox tile would be.
    expect(html).toContain("xl:grid-cols-3");
  });

  it("shows one failed widget without taking the others down", () => {
    const html = render(
      <DashboardWidgets
        widgets={{ lastBackup: { state: "error" }, readiness: ok("readiness") }}
        loading={false}
        canAdminister
        {...context}
      />,
    );
    expect(html).toMatch(/data-widget="lastBackup" data-state="error"/);
    expect(html).toMatch(/data-widget="readiness" data-state="ready"/);
  });

  it("expects the admin widgets only for admins while loading", () => {
    expect(expectedWidgets(true)).toContain("recentJobs");
    expect(expectedWidgets(true)).toContain("mailboxUsage");
    expect(expectedWidgets(true)).toContain("endpoints");
    expect(expectedWidgets(false)).not.toContain("recentJobs");
    expect(expectedWidgets(false)).not.toContain("mailboxUsage");
    expect(expectedWidgets(false)).not.toContain("endpoints");
    expect(expectedWidgets(false)).toContain("readiness");
  });

  it("places every widget the server can return, once, in one page order", () => {
    // The server still answers `setup` (the Start entry and the tenant page read it); the page places none.
    const all: (keyof WidgetData)[] = [
      "lastBackup",
      "readiness",
      "protectedObjects",
      "storage",
      "mailboxUsage",
      "endpoints",
      "backupTrend",
      "verificationHistory",
      "storageGrowth",
      "retention",
      "recentJobs",
    ];
    expect([...PAGE_WIDGETS].sort()).toEqual([...all].sort());
    expect(new Set(PAGE_WIDGETS).size).toBe(PAGE_WIDGETS.length);
  });

  it("lets every widget shrink to the page width, so wide tables scroll inside their card", () => {
    const html = render(
      <DashboardWidgets
        widgets={Object.fromEntries(PAGE_WIDGETS.map((id) => [id, ok(id)])) as TenantWidgets}
        loading={false}
        canAdminister
        {...context}
      />,
    );
    const cells = html.match(/<div data-slot="widget-cell" class="[^"]*"/g) ?? [];
    expect(cells.length).toBe(PAGE_WIDGETS.length + 1); // backupTrend feeds two entries
    for (const cell of cells) {
      // grid-cols-1 is minmax(0, 1fr): a card never grows to its table's min-content width.
      expect(cell).toContain("grid grid-cols-1");
    }
  });

  it("shows skeletons for the expected widgets while loading", () => {
    const admin = render(
      <DashboardWidgets widgets={undefined} loading canAdminister {...context} />,
    );
    expect(admin).toMatch(/data-widget="recentJobs" data-state="loading"/);
    expect(admin).toMatch(/data-widget="mailboxUsage" data-state="loading"/);
    const member = render(
      <DashboardWidgets widgets={undefined} loading canAdminister={false} {...context} />,
    );
    expect(member).not.toContain('data-widget="recentJobs"');
  });

  describe("the servers and clients card", () => {
    const only = (result: WidgetResult<WidgetData["endpoints"]>) =>
      render(
        <DashboardWidgets
          widgets={{
            readiness: ok("readiness"),
            protectedObjects: ok("protectedObjects"),
            endpoints: result,
          }}
          loading={false}
          canAdminister
          {...context}
        />,
      );

    it("sits after the figures row and before the trends", () => {
      const html = render(
        <DashboardWidgets
          widgets={Object.fromEntries(PAGE_WIDGETS.map((id) => [id, ok(id)])) as TenantWidgets}
          loading={false}
          canAdminister
          {...context}
        />,
      );
      const at = (marker: string) => html.indexOf(marker);
      expect(at('data-widget="protectedObjects"')).toBeGreaterThan(-1);
      expect(at('data-widget="endpoints"')).toBeGreaterThan(at('data-widget="protectedObjects"'));
      expect(at('data-widget="endpoints"')).toBeGreaterThan(at('data-widget="readiness"'));
      expect(at('data-widget="endpoints"')).toBeLessThan(at('data-widget="backupTrend"'));
    });

    it("shows machines when the tenant has some", () => {
      expect(only(ok("endpoints"))).toMatch(/data-widget="endpoints" data-state="ready"/);
    });

    it("renders nothing for a tenant without servers or clients, not even an empty section", () => {
      const html = only({
        state: "ok",
        data: {
          protected: 0,
          machines: 0,
          withoutJob: 0,
          servers: 0,
          clients: 0,
          readiness: { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
          notReady: 0,
          failedLastBackup: 0,
          needingAttention: 0,
          otherAttention: 0,
          lastSuccessAt: null,
        },
      });
      expect(html).not.toContain('data-widget="endpoints"');
      expect(html).not.toContain('data-section="endpoints"');
      expect(html).toContain('data-widget="readiness"');
    });

    it("shows no card for a plain member, whose response has none", () => {
      const html = render(
        <DashboardWidgets
          widgets={{ readiness: ok("readiness") }}
          loading={false}
          canAdminister={false}
          {...context}
        />,
      );
      expect(html).not.toContain('data-widget="endpoints"');
    });

    it("shows its failure with a retry, because the tenant may well have machines", () => {
      const html = only({ state: "error" });
      expect(html).toMatch(/data-widget="endpoints" data-state="error"/);
      expect(html).toContain("Retry");
      expect(html).toMatch(/data-widget="readiness" data-state="ready"/);
    });

    it("shows no skeleton while loading: most tenants have no machines", () => {
      const html = render(
        <DashboardWidgets widgets={undefined} loading canAdminister {...context} />,
      );
      expect(html).not.toContain('data-widget="endpoints"');
      expect(html).toMatch(/data-widget="readiness" data-state="loading"/);
    });
  });
});
