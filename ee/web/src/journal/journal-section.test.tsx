import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ArchivePage } from "@/features/archive/archive-page";
import { i18n } from "@/i18n";
import { registerWebExtension, resetWebExtensionsForTesting } from "@/lib/extensions";

import { eeWebExtension } from "../index";
import { type JournalSetup, journalKeys } from "./api";
import { JournalSection } from "./journal-section";

/**
 * The journal section: shown to a tenant administrator on an edition with the
 * journal receiver, absent otherwise, each status as the administrator sees
 * it, and rendered by the core archive page (next to legal holds) once the
 * ee/web extension is registered (slot `archive.sections`).
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    // The archive page links to the tenant settings; no <RouterProvider> here.
    Link: ({ to, children, ...props }: { to: string; children?: React.ReactNode }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 }),
}));

let sessionState: {
  status: string;
  activeTenant: { id: string; role: string } | null;
  isProviderAdmin: boolean;
  extensions: Record<string, unknown> | null;
};

vi.mock("@/lib/session", () => ({
  useSession: () => sessionState,
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  resetWebExtensionsForTesting();
});

const TOKEN = "q2w3e4r5t6y7u8i9o2p3a4s5d6f7g2h3";

const setupData: JournalSetup = {
  address: `journal+${TOKEN}@archive.example.test`,
  localPart: `journal+${TOKEN}`,
  hostname: "archive.example.test",
  hostnameIssue: null,
  status: "receiving",
  receiver: { listening: true, reason: null },
  lastReportAt: "2026-09-30T10:00:00.000Z",
  counts: { last24Hours: 12, last7Days: 80 },
  requirements: {
    dnsName: "archive.example.test",
    smtpPort: 25,
    exchangePort: 25,
    portMismatch: false,
    tlsConfigured: true,
    maxMessageMegabytes: 150,
  },
  docsUrl: "https://docs.example.test/administrators/exchange-journaling/",
};

function session(edition: string, role = "tenant_admin") {
  sessionState = {
    status: "authenticated",
    activeTenant: { id: "t-1", role },
    isProviderAdmin: false,
    extensions: { edition },
  };
}

function render(node: React.ReactNode, data?: JournalSetup): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (data) {
    client.setQueryData(journalKeys.setup("t-1"), data);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("JournalSection", () => {
  it("shows the address, the status and the counts to a tenant administrator on Business", () => {
    session("business");
    const html = render(<JournalSection />, setupData);
    expect(html).toContain("Exchange journaling");
    expect(html).toContain(`journal+${TOKEN}@archive.example.test`);
    expect(html).toContain("Copy journal address");
    expect(html).toContain("Receiving");
    expect(html).toContain("12 reports");
    expect(html).toContain("80 reports");
    expect(html).toContain('dateTime="2026-09-30T10:00:00.000Z"');
    expect(html).toContain("Rotate address");
    expect(html).toContain("Setup requirements and guide");
  });

  it("guides through the connector, the undeliverable mailbox and the journal rule", () => {
    session("business");
    const html = render(<JournalSection />, { ...setupData, status: "no_reports" });
    expect(html).toContain("No reports yet");
    for (const fragment of [
      "Set up Exchange Online",
      "Create a connector",
      "admin.exchange.microsoft.com",
      "Route it to the journal host",
      "the smart host archive.example.test",
      "Always use TLS",
      "Name a mailbox for undeliverable reports",
      "purview.microsoft.com",
      "Create the journal rule",
      "All messages",
      "Check that it works",
    ]) {
      expect(html).toContain(fragment);
    }
    expect(html).toContain('href="https://docs.example.test/administrators/exchange-journaling/"');
  });

  it("keeps the guide folded once reports are arriving", () => {
    session("business");
    expect(render(<JournalSection />, setupData)).not.toContain("Create a connector");
  });

  it("says when reports stopped", () => {
    session("business");
    const html = render(<JournalSection />, { ...setupData, status: "stale" });
    expect(html).toContain("No report for more than 24 hours");
  });

  it("names the reason, in red, when a configured receiver is not running", () => {
    session("business");
    const html = render(<JournalSection />, {
      ...setupData,
      status: "receiver_down",
      receiver: { listening: false, reason: "listen_failed" },
      lastReportAt: null,
    });
    expect(html).toContain("Receiver not running");
    expect(html).toContain('data-tone="destructive"');
    expect(html).toContain('data-variant="destructive"');
    expect(html).toContain("The receiver could not start");
    expect(html).toContain("None yet");
    // A configured receiver that is down gets the guide open, as before.
    expect(html).toContain("Create a connector");
  });

  describe("an installation that does not use journaling", () => {
    const notConfigured: JournalSetup = {
      ...setupData,
      status: "not_configured",
      receiver: { listening: false, reason: "port_not_configured" },
      lastReportAt: null,
      counts: { last24Hours: 0, last7Days: 0 },
      requirements: {
        ...setupData.requirements,
        smtpPort: null,
        portMismatch: false,
        tlsConfigured: false,
      },
    };

    it("shows a neutral badge and one sentence on what is needed, not a failure", () => {
      session("business");
      const html = render(<JournalSection />, notConfigured);
      expect(html).toContain("Not set up");
      expect(html).toContain('data-tone="muted"');
      expect(html).toContain("Journaling is not set up on this installation");
      expect(html).toContain("JOURNAL_SMTP_PORT, JOURNAL_HOSTNAME and a TLS certificate");
      expect(html).not.toContain("Receiver not running");
      expect(html).not.toContain("is off");
      expect(html).not.toContain("journal.status.");
      expect(html).not.toContain("journal.notConfigured");
    });

    it("shows no red and no amber: no alert of any kind", () => {
      session("business");
      const html = render(<JournalSection />, notConfigured);
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('data-variant="destructive"');
      expect(html).not.toContain('data-variant="warning"');
      expect(html).not.toContain('data-tone="destructive"');
      expect(html).not.toContain('data-tone="warning"');
    });

    it("does not warn about a missing journal host before journaling is set up", () => {
      session("business");
      const html = render(<JournalSection />, {
        ...notConfigured,
        address: null,
        hostname: null,
        hostnameIssue: "missing",
        requirements: { ...notConfigured.requirements, dnsName: null },
      });
      expect(html).not.toContain("No journal host name is configured");
      expect(html).not.toContain('role="alert"');
    });

    it("keeps the setup guide folded, still reachable from its trigger", () => {
      session("business");
      const html = render(<JournalSection />, notConfigured);
      expect(html).toContain("Setup requirements and guide");
      expect(html).not.toContain("Create a connector");
      expect(html).not.toContain("What Exchange Online needs from this installation");
    });

    it("is neutral in German as well", async () => {
      session("business");
      try {
        await i18n.changeLanguage("de");
        const html = render(<JournalSection />, notConfigured);
        expect(html).toContain("Nicht eingerichtet");
        expect(html).toContain("Journaling ist auf dieser Installation nicht eingerichtet");
        expect(html).not.toContain("Empfänger läuft nicht");
        expect(html).not.toContain('role="alert"');
        expect(html).not.toContain("journal.");
      } finally {
        await i18n.changeLanguage("en");
      }
    });
  });

  const tlsReasons = [
    {
      reason: "tls_not_configured",
      en: [
        "The receiver is not running because it has no TLS certificate",
        "Exchange Online requires TLS",
        "JOURNAL_TLS_CERT_PATH and JOURNAL_TLS_KEY_PATH",
        "restart the api",
      ],
      de: [
        "Der Empfänger läuft nicht, weil er kein TLS-Zertifikat hat",
        "Exchange Online verlangt TLS",
        "JOURNAL_TLS_CERT_PATH und JOURNAL_TLS_KEY_PATH",
        "starten Sie die API neu",
      ],
    },
    {
      reason: "tls_invalid",
      en: [
        "its TLS certificate cannot be used",
        "readable PEM files",
        "must not be encrypted",
        "The api log names the file",
      ],
      de: [
        "sein TLS-Zertifikat nicht verwendet werden kann",
        "lesbare PEM-Dateien",
        "nicht verschlüsselt sein",
        "Das API-Log nennt die Datei",
      ],
    },
    {
      reason: "tls_expired",
      en: [
        "The TLS certificate of the receiver has expired",
        "Exchange Online cannot deliver",
        "picks up renewed files within a few minutes",
      ],
      de: [
        "Das TLS-Zertifikat des Empfängers ist abgelaufen",
        "Exchange Online kann daher nicht zustellen",
        "übernimmt erneuerte Dateien innerhalb weniger Minuten",
      ],
    },
  ] as const;

  it.each(tlsReasons)("names the TLS reason $reason in English and in German", async (entry) => {
    session("business");
    const data: JournalSetup = {
      ...setupData,
      status: "receiver_down",
      receiver: { listening: false, reason: entry.reason },
      lastReportAt: null,
    };
    try {
      const english = render(<JournalSection />, data);
      expect(english).toContain("Receiver not running");
      for (const fragment of entry.en) {
        expect(english).toContain(fragment);
      }
      expect(english).not.toContain("journal.reason.");

      await i18n.changeLanguage("de");
      const german = render(<JournalSection />, data);
      expect(german).toContain("Empfänger läuft nicht");
      for (const fragment of entry.de) {
        expect(german).toContain(fragment);
      }
      expect(german).not.toContain("journal.reason.");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("does not show a TLS certificate as configured while the receiver cannot serve it", () => {
    session("business");
    const html = render(<JournalSection />, {
      ...setupData,
      status: "receiver_down",
      receiver: { listening: false, reason: "tls_invalid" },
      requirements: { ...setupData.requirements, tlsConfigured: false },
    });
    expect(html).toContain("No usable TLS certificate is configured");
    expect(html).not.toContain("TLS is required");
  });

  it("explains a missing journal host instead of showing an address that leads nowhere", () => {
    session("business");
    const html = render(<JournalSection />, {
      ...setupData,
      status: "no_reports",
      address: null,
      hostname: null,
      hostnameIssue: "missing",
      requirements: { ...setupData.requirements, dnsName: null },
    });
    expect(html).toContain("No journal host name is configured");
    expect(html).toContain('data-variant="warning"');
    expect(html).toContain("JOURNAL_HOSTNAME");
    expect(html).not.toContain("Copy journal address");
    expect(html).toContain(`journal+${TOKEN}@`);
    expect(html).toContain("the smart host [journal host]");
  });

  it("warns about a port Exchange Online does not use and about missing TLS", () => {
    session("business");
    const html = render(<JournalSection />, {
      ...setupData,
      requirements: {
        ...setupData.requirements,
        smtpPort: 2525,
        portMismatch: true,
        tlsConfigured: false,
      },
      status: "no_reports",
    });
    expect(html).toContain("listens on port 2525");
    expect(html).toContain("Forward port 25");
    expect(html).toContain("No usable TLS certificate is configured");
  });

  it("says TLS is required when a certificate is served", () => {
    session("business");
    const html = render(<JournalSection />, { ...setupData, status: "no_reports" });
    expect(html).toContain("TLS is required");
    expect(html).not.toContain("No usable TLS certificate");
  });

  it("renders nothing on the Community edition", () => {
    session("community");
    expect(render(<JournalSection />, setupData)).toBe("");
  });

  it("renders nothing for a plain tenant user", () => {
    session("service_provider", "tenant_user");
    expect(render(<JournalSection />, setupData)).toBe("");
  });

  it("appears on the core archive page once the ee/web extension is registered, without legal holds, which are a setting of the tenant", () => {
    session("business");
    expect(render(<ArchivePage />)).not.toContain("Exchange journaling");
    registerWebExtension(eeWebExtension);
    const html = render(<ArchivePage />, setupData);
    expect(html).toContain("Exchange journaling");
    expect(html).not.toContain("Legal holds");
  });
});
