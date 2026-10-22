import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { type JournalSetup, journalKeys } from "./api";
import { JobArchiveSetup } from "./job-archive-setup";

/**
 * The archive section of a mail job's editor (slot `jobs.archiveSetup`, #32):
 * the tenant's journal address and status while the job archives, the way to
 * the guide, and the edition note where journaling is not included.
 */

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn().mockResolvedValue({}),
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

function render(archive: boolean): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(journalKeys.setup("t-1"), setup);
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <JobArchiveSetup archive={archive} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("JobArchiveSetup", () => {
  it("shows the journal address, its status and the way to the guide while the job archives", () => {
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

  it("says that capture needs the Business edition on Community", () => {
    edition = "community";
    const html = render(true);
    expect(html).toContain("Business edition");
    expect(html).not.toContain("journal+abc");
  });
});
