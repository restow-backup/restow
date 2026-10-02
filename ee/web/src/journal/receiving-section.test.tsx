import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { type JournalReceiver, fetchJournalReceiver, journalKeys } from "./api";
import { JournalReceivingContent, JournalReceivingSection } from "./receiving-section";

/**
 * Installation, Journal receiving: the receiver as the server reports it, for
 * every tenant. Each state, the reasons it can be down, what Exchange Online
 * needs from this server, and that no tenant's address or guide is here.
 */

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn().mockRejectedValue(new Error("no request expected")),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const RECEIVER: JournalReceiver = {
  state: "listening",
  receiver: { listening: true, reason: null },
  hostname: "archive.example.test",
  hostnameIssue: null,
  requirements: {
    dnsName: "archive.example.test",
    smtpPort: 25,
    exchangePort: 25,
    portMismatch: false,
    tlsConfigured: true,
    maxMessageMegabytes: 150,
  },
  lastReportAt: "2026-10-02T09:00:00.000Z",
  last24Hours: 41,
  docsUrl: "https://docs.example.test/administrators/exchange-journaling/",
};

function render(node: React.ReactNode, data?: JournalReceiver | "error"): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  if (data === "error") {
    client
      .getQueryCache()
      .build(client, { queryKey: journalKeys.receiver })
      .setState({ status: "error", error: new Error("down"), fetchStatus: "idle" });
  } else if (data) {
    client.setQueryData(journalKeys.receiver, data);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("JournalReceivingSection", () => {
  it("shows the receiver, its port, host, TLS certificate and size limit as the server sets them", () => {
    const html = render(<JournalReceivingSection />, RECEIVER);
    expect(html).toContain("Receiver");
    expect(html).toContain("Receiving");
    expect(html).toContain(">25<");
    expect(html).toContain("archive.example.test");
    expect(html).toContain("Configured");
    expect(html).toContain("150 MB");
    expect(html).toContain("41");
    expect(html).toContain('dateTime="2026-10-02T09:00:00.000Z"');
    expect(html).toContain("The values come from the server environment");
  });

  it("is a state, not a restore proof: a receiver that listens is Lapis work, never the green of a check", () => {
    const html = render(<JournalReceivingContent receiver={RECEIVER} />);
    expect(html).toContain('data-tone="info"');
    expect(html).not.toMatch(/data-tone="success"/);
  });

  it("says what Exchange Online needs from this server, with the host from the configuration", () => {
    const html = render(<JournalReceivingContent receiver={RECEIVER} />);
    expect(html).toContain("What Exchange Online needs from this server");
    expect(html).toContain("Publish archive.example.test in DNS");
    expect(html).toContain("The receiver listens on port 25");
    expect(html).toContain("TLS is required");
    expect(html).toContain("Reports up to 150 MB are accepted");
    expect(html).toContain('href="https://docs.example.test/administrators/exchange-journaling/"');
  });

  it("keeps the tenants' own parts off the page and says where they are", () => {
    const html = render(<JournalReceivingContent receiver={RECEIVER} />);
    expect(html).toContain("on the Archive page of that tenant");
    expect(html).not.toContain("journal+");
    expect(html).not.toContain("Rotate address");
    expect(html).not.toContain("Copy journal address");
    expect(html).not.toContain("Set up Exchange Online");
  });

  it("says why the receiver is down, including the restart a newly installed license key needs", () => {
    const html = render(
      <JournalReceivingContent
        receiver={{
          ...RECEIVER,
          state: "down",
          receiver: { listening: false, reason: "restart_required" },
        }}
      />,
    );
    expect(html).toContain("Receiver not running");
    expect(html).toContain('data-tone="destructive"');
    expect(html).toContain("Restart the api to start the receiver.");
  });

  it("calls a certificate that cannot be used by its name, and a missing one a to-do", () => {
    const expired = render(
      <JournalReceivingContent
        receiver={{
          ...RECEIVER,
          state: "down",
          receiver: { listening: false, reason: "tls_expired" },
          requirements: { ...RECEIVER.requirements, tlsConfigured: false },
        }}
      />,
    );
    expect(expired).toContain("The TLS certificate of the receiver has expired");
    expect(expired).toContain("Not usable");
  });

  it("treats a server that does not use journaling as no fault", () => {
    const html = render(
      <JournalReceivingContent
        receiver={{
          ...RECEIVER,
          state: "not_configured",
          receiver: { listening: false, reason: "port_not_configured" },
          hostname: null,
          hostnameIssue: "missing",
          requirements: {
            ...RECEIVER.requirements,
            smtpPort: null,
            tlsConfigured: false,
            dnsName: null,
          },
          lastReportAt: null,
          last24Hours: 0,
        }}
      />,
    );
    expect(html).toContain("Not set up");
    expect(html).toContain("Journaling is not set up on this installation.");
    expect(html).toContain("None yet");
    expect(html).not.toContain('data-tone="destructive"');
    // The missing host is not a warning before journaling is used at all.
    expect(html).not.toContain("No journal host name is configured");
  });

  it("warns about a missing or invalid journal host once the receiver is configured", () => {
    const html = render(
      <JournalReceivingContent
        receiver={{ ...RECEIVER, hostname: null, hostnameIssue: "invalid" }}
      />,
    );
    expect(html).toContain("JOURNAL_HOSTNAME is not a valid host name");
  });

  it("forwards port 25 when the receiver listens elsewhere", () => {
    const html = render(
      <JournalReceivingContent
        receiver={{
          ...RECEIVER,
          requirements: { ...RECEIVER.requirements, smtpPort: 2525, portMismatch: true },
        }}
      />,
    );
    expect(html).toContain("the receiver listens on port 2525");
  });

  it("shows a skeleton while loading and says when the receiver cannot be read", () => {
    expect(render(<JournalReceivingSection />)).toContain('aria-busy="true"');
    expect(render(<JournalReceivingSection />, "error")).toContain(
      "The journal receiver could not be read.",
    );
  });

  it("asks for the receiver without naming a tenant", async () => {
    const { apiFetch } = await import("@/lib/api");
    vi.mocked(apiFetch).mockResolvedValueOnce(RECEIVER);
    await fetchJournalReceiver();
    expect(apiFetch).toHaveBeenCalledWith("/archive/journal/receiver", { tenantId: null });
  });
});
