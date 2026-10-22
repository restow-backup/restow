// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { CaptureKind } from "@/features/backup-jobs/api";
import type { CaptureWays } from "@/features/backup-jobs/capture-ways";
import { i18n } from "@/i18n";

import { type JournalSetup, journalKeys } from "./api";
import { JobArchiveSetup } from "./job-archive-setup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The archive section of a mail job's editor (slot `jobs.archiveSetup`, #32): the tenant's
 * journal address and status while the job archives Microsoft 365 mailboxes by Exchange
 * journaling, the way to the guide; and never a request for the journal address (which
 * issues it) for a job that does not journal.
 */

const apiFetch = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

let edition = "business";
vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", role: "tenant_admin" },
    isProviderAdmin: false,
    extensions: { edition },
  }),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const setup = {
  address: "journal+abc@archive.example.test",
  localPart: "journal+abc",
  hostname: "archive.example.test",
  hostnameIssue: null,
  status: "receiving",
  receiver: { listening: true, reason: null },
  lastReportAt: "2026-09-30T10:00:00.000Z",
  counts: { last24Hours: 1, last7Days: 2 },
  requirements: {
    dnsName: "archive.example.test",
    smtpPort: 25,
    exchangePort: 25,
    portMismatch: false,
    tlsConfigured: true,
    maxMessageMegabytes: 150,
  },
  docsUrl: null,
} as JournalSetup;

const JOURNAL: CaptureWays = {
  m365: { graph: true, journal: true },
  imap: { sync: true, forward: false },
  google: { sync: true, forward: false },
};
const GRAPH_ONLY: CaptureWays = { ...JOURNAL, m365: { graph: true, journal: false } };

function element(archive: boolean, kinds: CaptureKind[], capture: CaptureWays) {
  return <JobArchiveSetup archive={archive} kinds={kinds} capture={capture} />;
}

function render(
  archive: boolean,
  kinds: CaptureKind[] = ["m365"],
  capture: CaptureWays = JOURNAL,
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(journalKeys.setup("t-1"), setup);
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>{element(archive, kinds, capture)}</QueryClientProvider>
    </I18nextProvider>,
  );
}

/** Mounted for real (queries run), with an empty cache: what would it ask the server? */
async function requestsOf(kinds: CaptureKind[], capture: CaptureWays): Promise<string[]> {
  apiFetch.mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>{element(true, kinds, capture)}</QueryClientProvider>
      </I18nextProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () => root.unmount());
  container.remove();
  client.clear();
  return apiFetch.mock.calls.map((call) => String(call[0]));
}

describe("JobArchiveSetup", () => {
  it("shows the journal address, its status and the way to the guide while the job journals", () => {
    edition = "business";
    const html = render(true);
    expect(html).toContain("journal+abc@archive.example.test");
    expect(html).toContain("Open the guide in the archive");
    expect(html).toContain('href="/archive"');
  });

  it("shows nothing while the job does not archive", () => {
    edition = "business";
    expect(render(false)).toBe("");
  });

  it("shows nothing for a job that captures by Graph or IMAP only", () => {
    edition = "business";
    expect(render(true, ["m365"], GRAPH_ONLY)).toBe("");
    expect(render(true, ["imap", "google"], JOURNAL)).toBe("");
  });

  it("leaves the edition to the core's capture ways on Community", () => {
    edition = "community";
    expect(render(true)).toBe("");
  });

  it("never requests the journal address for an IMAP-only job", async () => {
    edition = "business";
    expect(await requestsOf(["imap"], JOURNAL)).toEqual([]);
    expect(await requestsOf(["imap_microsoft", "google"], JOURNAL)).toEqual([]);
    expect(await requestsOf(["m365"], GRAPH_ONLY)).toEqual([]);
    // Exchange journaling chosen for Microsoft 365 mailboxes: now it asks.
    expect(await requestsOf(["m365", "imap"], JOURNAL)).toEqual(["/archive/journal"]);
  });
});
