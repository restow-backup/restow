import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { count } from "@/components/kit/test-utils";
import type { Failure } from "@/features/failures/api";
import { i18n } from "@/i18n";

import { type CheckedItem, type Reason, type ReportDetail, verifyKeys } from "./api";
import "./i18n";
import { ReportPage } from "./report-page";

/**
 * A readiness report rendered to static markup with the query cache
 * pre-filled: every finding, failed item, test-restore item and the manifest
 * problem explained; a report from before causes existed reads as it always did.
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      className,
      children,
    }: { to: string; className?: string; children: React.ReactNode }) => (
      <a href={String(to)} className={className}>
        {children}
      </a>
    ),
  };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

const DOCS = "https://docs.example.test/troubleshooting";

function failure(code: string, overrides: Partial<Failure> = {}): Failure {
  return {
    code,
    category: "verify",
    transient: false,
    retryable: true,
    params: {},
    technical: {},
    occurredAt: "2026-09-20T03:00:00.000Z",
    step: null,
    retry: null,
    steps: [],
    docsUrl: DOCS,
    ...overrides,
  };
}

const hashMismatch = failure("verify.hash_mismatch", {
  params: { count: 2 },
  steps: [{ id: "run_backup_again", target: "jobs" }],
});
const snapshotStale = failure("verify.snapshot_stale", {
  params: { ageHours: 60 },
  steps: [{ id: "run_backup_again", target: "jobs" }],
});
const packUnreadable = failure("verify.pack_unreadable", {
  technical: { path: "packs/ab/cd.pack" },
  steps: [{ id: "check_storage_health", target: "storage" }],
});
const restoreRejected = failure("verify.restore_test_failed", {
  steps: [{ id: "check_test_target", target: "source" }],
});
const manifestCause = failure("storage.path_missing", {
  category: "storage",
  technical: { path: "manifests/0007.json" },
  steps: [{ id: "check_storage_path", target: "storage" }],
});

function reasons(explained: boolean): Reason[] {
  return [
    {
      code: "snapshot_stale",
      severity: "yellow",
      count: null,
      ageHours: 60,
      failure: explained ? snapshotStale : null,
    },
    {
      code: "items_mismatched",
      severity: "red",
      count: 2,
      ageHours: null,
      failure: explained ? hashMismatch : null,
    },
  ];
}

function item(overrides: Partial<CheckedItem> = {}): CheckedItem {
  return {
    path: "Inbox/2026/mail-1.eml",
    id: "m-1",
    category: "mail",
    size: 2048,
    bytesRead: 0,
    chunks: 2,
    status: "unreadable",
    objectHash: "not_reached",
    reason: "Pack could not be fetched",
    failure: null,
    ...overrides,
  };
}

function report(explained: boolean): ReportDetail {
  return {
    id: "r-1",
    object: {
      id: "o-1",
      kind: "mailbox",
      displayName: "Ada Example",
      externalId: "11111111-1111-4111-8111-111111111111",
      status: "active",
      email: "ada@contoso.test",
      upn: null,
    },
    kind: "verify",
    origin: "verify",
    readiness: "red",
    checkedAt: "2026-09-20T03:00:00.000Z",
    jobId: "job-1",
    snapshotId: "s-1",
    reasons: reasons(explained),
    counts: { checked: 30, verified: 27, failed: 3 },
    details: {
      origin: "verify",
      kind: "verify",
      scope: "sample",
      seed: 7,
      snapshot: {
        id: "s-1",
        sequence: 4,
        completedAt: "2026-09-19T02:00:00.000Z",
        itemCount: 400,
        packCount: 9,
      },
      manifestFailure: explained ? manifestCause : null,
      counts: {
        eligible: { mail: 300, file: 100, event: 0, contact: 0 },
        sampled: { mail: 20, file: 10, event: 0, contact: 0 },
        checked: 30,
        verified: 27,
        mismatch: 1,
        missing: 0,
        unreadable: 2,
        bytesRead: 123456,
      },
      items: [
        item({ failure: explained ? packUnreadable : null }),
        item({
          path: "Inbox/2026/mail-2.eml",
          status: "mismatch",
          objectHash: "mismatched",
          reason: null,
          failure: explained ? hashMismatch : null,
        }),
      ],
      itemsOmitted: 0,
      damagedPacks: [],
      testRestore: {
        target: "Restore check mailbox",
        items: [
          {
            path: "Inbox/2026/mail-3.eml",
            status: "failed",
            reason: "Target answered 400",
            failure: explained ? restoreRejected : null,
          },
          { path: "Inbox/2026/mail-4.eml", status: "confirmed", reason: null, failure: null },
        ],
      },
      startedAt: "2026-09-20T03:00:00.000Z",
      durationMs: 4200,
    },
    latestBackup: null,
  };
}

function render(data: ReportDetail): string {
  const client = new QueryClient();
  client.setQueryData(verifyKeys.report("t-1", data.id), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <ReportPage reportId={data.id} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("ReportPage failure explanations", () => {
  it("explains every finding, red before yellow, with why, steps and the docs link", () => {
    const html = render(report(true));
    const red = html.indexOf("Restored data does not match the backup");
    const yellow = html.indexOf("The latest backup is getting old");
    expect(red).toBeGreaterThan(-1);
    expect(yellow).toBeGreaterThan(red);
    expect(html).toContain("2 checked items came back");
    expect(html).toContain("Run a new backup.");
    expect(html).toContain('href="/backup"');
    expect(html).toContain(`href="${DOCS}"`);
    expect(html).toContain("Troubleshooting guide");
  });

  it("does not repeat the object in the explanation: the page names it in its title", () => {
    const html = render(report(true));
    expect(html).not.toContain("What happened");
    expect(html).toContain("Ada Example");
  });

  it("explains failed items next to their existing technical detail", () => {
    const html = render(report(true));
    expect(html).toContain("Pack could not be fetched");
    expect(html).toContain('data-cause="verify.pack_unreadable"');
    expect(html).toContain("Backup data in the storage is damaged");
    expect(html).toContain("packs/ab/cd.pack");
  });

  it("explains a failed test-restore item next to its reason", () => {
    const html = render(report(true));
    expect(html).toContain("Target answered 400");
    expect(html).toContain('data-cause="verify.restore_test_failed"');
    expect(html).toContain("The test restore failed");
    expect(html).toContain("Check the test restore target of the source");
  });

  it("explains why the manifest could not be read", () => {
    const html = render(report(true));
    expect(html).toContain("Why the catalogue of this backup could not be read");
    expect(html).toContain("The storage folder does not exist");
    expect(html).toContain("manifests/0007.json");
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    const html = render(report(true));
    expect(html).toContain("Wiederhergestellte Daten stimmen nicht mit dem Backup überein");
    expect(html).toContain("Das letzte Backup wird alt");
    expect(html).toContain("Was zu tun ist");
    expect(html).toContain("Anleitung zur Fehlersuche");
    expect(html).toContain("Warum das Verzeichnis dieses Backups nicht gelesen werden konnte");
    expect(html).toContain("Backup-Daten im Speicher sind beschädigt");
    expect(html).not.toContain("What to do");
  });

  it("reads as before for a report without classified causes", () => {
    const html = render(report(false));
    // The translated finding lines, red first, in the old list.
    const red = html.indexOf("2 items came back different from what was backed up.");
    const yellow = html.indexOf("The latest backup is 60 hours old.");
    expect(red).toBeGreaterThan(-1);
    expect(yellow).toBeGreaterThan(red);
    // The recorded detail of the items and the test restore, as always.
    expect(html).toContain("Pack could not be fetched");
    expect(html).toContain("Target answered 400");
    // No explanation, no empty box.
    expect(html).not.toContain("data-cause");
    expect(html).not.toContain("What to do");
    expect(html).not.toContain("Why the catalogue of this backup could not be read");
    expect(count(html, 'data-slot="alert"')).toBe(0);
  });

  it("reads as before in German for a report without classified causes", async () => {
    await i18n.changeLanguage("de");
    const html = render(report(false));
    expect(html).not.toContain("data-cause");
    expect(html).not.toContain("Was zu tun ist");
    expect(html).toContain("Pack could not be fetched");
  });

  it("says there are no findings for a green report", () => {
    const green: ReportDetail = { ...report(true), readiness: "green", reasons: [] };
    const html = render(green);
    expect(html).toContain("No findings");
  });
});
