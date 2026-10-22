// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n.js";
import type { ArchiveHold, CaptureMailbox, CaptureStatus } from "./api.js";
import { ArchivePage } from "./archive-page.js";

/**
 * Capture on the archive page (0.4.4, docs/ARCHIVE.md "Erfassungswege"): the state of Graph
 * and IMAP archiving, the capture per mailbox with a catch-up, the hold confirmation of
 * Microsoft 365 sources with its check commands; and in the search a forwarded copy, a mail
 * captured afterwards, other ways that captured it again and the link between a replaced
 * capture and the one that replaced it.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({ to, children, ...props }: { to: string; children?: React.ReactNode }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});
let features: string[] = ["archive.mailboxCapture", "archive.smtpCapture"];
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", role: "tenant_admin" },
    isProviderAdmin: false,
    features,
  }),
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: (path: string, init?: unknown) => apiFetch(path, init) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const counts = {
  lastCapturedAt: "2026-10-22T09:00:00.000Z",
  items24h: 12,
  items7d: 80,
  captures24h: 3,
  captures7d: 9,
};

const STATUS: CaptureStatus = {
  mailbox: [
    {
      ...counts,
      way: "graph_sync",
      available: true,
      assurance: "mailbox",
      streams: { live: 3, backfilling: 1, pending: 0, paused: 0, disabled: 2, error: 1 },
      modes: { notifications: 2, poll: 1 },
      pollReasons: { "graph.notification_url_unavailable": 1 },
      backfill: { total: 4, completed: 3 },
      capturedLate7d: 40,
    },
    {
      ...counts,
      way: "imap_sync",
      available: false,
      assurance: "mailbox",
      streams: { live: 0, backfilling: 0, pending: 0, paused: 0, disabled: 0, error: 0 },
      modes: { notifications: 0, poll: 0 },
      pollReasons: {},
      backfill: { total: 0, completed: 0 },
      capturedLate7d: 0,
    },
  ],
  smtp: [],
  fileImport: { ...counts, assurance: "late" },
};

const MAILBOX: CaptureMailbox = {
  streamId: "s-1",
  protectedObjectId: "po-anna",
  kind: "mailbox",
  externalId: "anna@contoso.example",
  displayName: "Anna Berg",
  way: "graph_sync",
  status: "live",
  mode: "notifications",
  activatedAt: "2026-10-01T00:00:00.000Z",
  backfillCompletedAt: "2026-10-02T00:00:00.000Z",
  lastCaptureAt: "2026-10-22T09:00:00.000Z",
  lastSuccessAt: "2026-10-22T09:00:00.000Z",
  nextDueAt: null,
  consecutiveFailures: 0,
  failure: null,
};

const HOLD: ArchiveHold = {
  sourceId: "src-1",
  name: "Contoso 365",
  status: "unknown",
  confirmedBy: null,
  confirmedAt: null,
  graphMailboxes: 4,
};

const CHECKS = [
  { id: "connect_exchange", shell: "exchange", command: "Connect-ExchangeOnline" },
  {
    id: "retention_policies",
    shell: "compliance",
    command: "Get-RetentionCompliancePolicy -DistributionDetail",
  },
  { id: "future_check", shell: "exchange", command: "Get-Something" },
];

const RESULTS = [
  {
    id: "item-forwarded",
    subject: "Forwarded copy",
    from: "a@example.test",
    to: [],
    cc: [],
    receivedAt: "2026-10-01T10:00:00.000Z",
    sentAt: null,
    hasAttachment: false,
    sizeBytes: 100,
    flags: [],
    source: "smtp_forward",
    supersedesItemId: null,
    superseded: false,
    alsoCapturedVia: ["imap_sync"],
  },
  {
    id: "item-journal",
    subject: "Journaled",
    from: "a@example.test",
    to: [],
    cc: [],
    receivedAt: "2026-10-01T09:00:00.000Z",
    sentAt: null,
    hasAttachment: false,
    sizeBytes: 100,
    flags: [],
    source: "journal",
    supersedesItemId: "item-graph",
    superseded: false,
    alsoCapturedVia: [],
  },
  {
    id: "item-late",
    subject: "Old mail",
    from: "a@example.test",
    to: [],
    cc: [],
    receivedAt: "2026-09-01T09:00:00.000Z",
    sentAt: null,
    hasAttachment: false,
    sizeBytes: 100,
    flags: ["captured-late"],
    source: "graph_sync",
    supersedesItemId: null,
    superseded: false,
    alsoCapturedVia: [],
  },
];

function detail(id: string) {
  return {
    id,
    tenantId: "t-1",
    receivedAt: "2026-10-01T10:00:00.000Z",
    itemHash: "ab".repeat(32),
    chainHash: "cd".repeat(32),
    size: 100,
    envelope: { sender: "a@example.test", subject: "Mail", messageId: "<m@x>", recipients: [] },
    flags: id === "item-graph" ? [] : [],
    source: id === "item-graph" ? "graph_sync" : "journal",
    retentionUntil: null,
    supersedesItemId: id === "item-journal" ? "item-graph" : null,
    supersededBy: id === "item-graph" ? "item-journal" : null,
    captures:
      id === "item-journal"
        ? [{ via: "imap_sync", receivedAt: "2026-10-01T10:01:00.000Z", protectedObjectId: null }]
        : [],
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("capture on the archive page", () => {
  let container: HTMLDivElement;
  let root: Root;
  const slot = (name: string) => container.querySelector<HTMLElement>(`[data-slot="${name}"]`);

  async function settle(until: () => boolean) {
    for (let attempt = 0; attempt < 20 && !until(); attempt += 1) {
      await act(async () => {
        await flush();
      });
    }
  }

  async function mount() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <ArchivePage />
          </I18nextProvider>
        </QueryClientProvider>,
      );
      await flush();
    });
    await settle(
      () =>
        container.querySelector("tbody tr") !== null &&
        slot("capture-way-graph_sync") !== null &&
        slot("capture-hold") !== null,
    );
  }

  async function click(element: Element | null | undefined) {
    await act(async () => {
      (element as HTMLElement).click();
      await flush();
    });
  }

  const byText = (scope: ParentNode, text: string) =>
    [...scope.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);

  beforeEach(() => {
    features = ["archive.mailboxCapture", "archive.smtpCapture"];
    apiFetch.mockImplementation((path: string, init?: { method?: string; body?: unknown }) => {
      if (path.startsWith("/archive/search")) {
        return Promise.resolve({ items: RESULTS, total: RESULTS.length, limit: 50, offset: 0 });
      }
      if (path === "/archive/capture") return Promise.resolve(STATUS);
      if (path.startsWith("/archive/capture/mailboxes/") && init?.method === "POST") {
        return Promise.resolve({ streams: 1 });
      }
      if (path.startsWith("/archive/capture/mailboxes")) {
        return Promise.resolve({ items: [MAILBOX], nextCursor: null });
      }
      if (path === "/archive/capture/holds") {
        return Promise.resolve({ items: [HOLD], checks: CHECKS });
      }
      if (path.startsWith("/archive/capture/holds/") && init?.method === "PUT") {
        return Promise.resolve({
          ...HOLD,
          status: "confirmed",
          confirmedBy: "admin@contoso.example",
          confirmedAt: "2026-10-22T10:00:00.000Z",
        });
      }
      if (path.endsWith("/preview")) {
        return Promise.resolve({
          previewable: false,
          reason: "too-large",
          headers: { subject: "Mail", from: null, to: [], cc: [], date: null, messageId: null },
          attachments: [],
        });
      }
      const match = /^\/archive\/items\/(.+)$/.exec(path);
      if (match) return Promise.resolve(detail(match[1] as string));
      return Promise.resolve({});
    });
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    document.body.innerHTML = "";
    await i18n.changeLanguage("en");
  });

  it("shows each mailbox way with its streams, how mail is noticed and the takeover", async () => {
    await mount();
    const graph = slot("capture-way-graph_sync");
    expect(graph?.textContent).toContain("3 mailboxes live");
    expect(graph?.textContent).toContain("1 with an error");
    expect(graph?.textContent).not.toContain("switched off");
    expect(graph?.textContent).toContain("Notified by Microsoft: 2, checking at intervals: 1");
    // The reason's text comes from the failure catalog where it has one (workstream B's).
    expect(slot("capture-poll-reasons")?.textContent).toContain("1 mailbox checked at intervals:");
    expect(slot("capture-backfill")?.textContent).toContain("3 of 4 mailboxes");
    expect(graph?.textContent).toContain("Near-time");
    // IMAP archiving is not in this edition: said so, without counts of streams.
    expect(slot("capture-way-imap_sync")?.textContent).toContain("Business edition");
    // No green: a capture is not a passed restore check.
    expect(container.querySelector("#archive-capture .bg-success\\/15")).toBeNull();
  });

  it("catches a mailbox up on request, and only with the edition that has it", async () => {
    await mount();
    const row = slot("capture-mailbox-row");
    expect(row?.textContent).toContain("Anna Berg (anna@contoso.example)");
    await click(
      row?.querySelector(
        'button[aria-label="Catch up Anna Berg (anna@contoso.example) completely"]',
      ),
    );
    expect(apiFetch).toHaveBeenCalledWith("/archive/capture/mailboxes/po-anna/resync", {
      method: "POST",
    });
  });

  it("disables the catch-up without the edition", async () => {
    features = [];
    await mount();
    const button = slot("capture-mailbox-row")?.querySelector("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
  });

  it("asks for the hold confirmation with the commands that check it, and records it", async () => {
    await mount();
    const hold = slot("capture-hold");
    expect(hold?.textContent).toContain("Hold not confirmed");
    expect(hold?.textContent).toContain("4 mailboxes are captured by Graph");
    const checks = slot("capture-hold-checks");
    expect([...(checks?.querySelectorAll("pre") ?? [])].map((pre) => pre.textContent)).toEqual([
      "Connect-ExchangeOnline",
      "Get-RetentionCompliancePolicy -DistributionDetail",
      "Get-Something",
    ]);
    expect(checks?.textContent).toContain("Sign in to Exchange Online PowerShell");
    // A check this version has no text for is named by its id.
    expect(checks?.textContent).toContain("future_check");
    await click(byText(hold as HTMLElement, "Confirm hold"));
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog?.textContent).toContain("Confirm the hold for Contoso 365?");
    await click(byText(dialog, "Confirm hold"));
    await settle(() => slot("capture-hold")?.dataset.status === "confirmed");
    expect(apiFetch).toHaveBeenCalledWith("/archive/capture/holds/src-1", {
      method: "PUT",
      body: { status: "confirmed" },
    });
    expect(slot("capture-hold")?.textContent).toContain("Hold confirmed");
    expect(slot("capture-hold")?.textContent).toContain("admin@contoso.example");
  });

  it("shows no check commands from a server that sends none", async () => {
    const fallback = apiFetch.getMockImplementation();
    apiFetch.mockImplementation((path: string, init?: unknown) =>
      path === "/archive/capture/holds"
        ? Promise.resolve({ items: [HOLD] })
        : fallback?.(path, init),
    );
    await mount();
    expect(slot("capture-hold")).not.toBeNull();
    expect(slot("capture-hold-checks")).toBeNull();
  });

  it("names a forwarded copy, a late capture and the other ways in the list", async () => {
    await mount();
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows[0]?.textContent).toContain("Forwarded");
    expect(rows[0]?.querySelector('[data-slot="archive-also-captured"]')?.textContent).toBe(
      "also via IMAP sync",
    );
    expect(rows[2]?.querySelector('[data-slot="archive-captured-late"]')?.textContent).toBe(
      "Captured afterwards",
    );
    // Replaced captures are not asked for until the person does.
    const first = apiFetch.mock.calls.find(([path]) => String(path).startsWith("/archive/search"));
    expect(String(first?.[0])).not.toContain("includeSuperseded");
    await click(container.querySelector("#archive-include-superseded"));
    await settle(() =>
      apiFetch.mock.calls.some(([path]) => String(path).includes("includeSuperseded=true")),
    );
    expect(
      apiFetch.mock.calls.some(([path]) => String(path).includes("includeSuperseded=true")),
    ).toBe(true);
  });

  it("links a capture to the one it replaced and lists the captures of the same mail", async () => {
    await mount();
    await click(container.querySelectorAll("tbody tr")[1]);
    await settle(() => slot("archive-supersedes") !== null);
    expect(slot("archive-detail-captures")?.textContent).toContain("IMAP sync");
    await click(slot("archive-supersedes"));
    await settle(() => slot("archive-superseded-by") !== null);
    expect(apiFetch).toHaveBeenCalledWith("/archive/items/item-graph", undefined);
    expect(slot("archive-superseded-by")?.textContent).toBe("a stronger capture of this mail");
  });

  it("is translated to German", async () => {
    await i18n.changeLanguage("de");
    await mount();
    expect(slot("capture-way-graph_sync")?.textContent).toContain("3 Postfächer laufend");
    expect(slot("capture-hold")?.textContent).toContain("Hold nicht bestätigt");
    expect(container.querySelectorAll("tbody tr")[0]?.textContent).toContain("Weiterleitung");
  });
});
