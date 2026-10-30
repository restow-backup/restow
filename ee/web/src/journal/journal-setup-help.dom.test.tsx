// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { JournalSetup } from "./api";
import { JournalSection } from "./journal-section";

/**
 * The journal section's setup help (0.4.4): the Exchange Online PowerShell commands, shown
 * once a valid mailbox for undeliverable journal reports is entered, and the wait for the
 * first report, which asks every 5 seconds until a report arrived after the wait began.
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", role: "tenant_admin" },
    isProviderAdmin: false,
    extensions: { edition: "business" },
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

const ADDRESS = "journal+abcdefghijklmnopqrstuvwxyz234567@archive.example.test";

function setup(overrides: Partial<JournalSetup> = {}): JournalSetup {
  return {
    address: ADDRESS,
    localPart: "journal+abcdefghijklmnopqrstuvwxyz234567",
    hostname: "archive.example.test",
    hostnameIssue: null,
    status: "no_reports",
    receiver: { listening: true, reason: null },
    lastReportAt: null,
    firstReportAt: null,
    counts: { last24Hours: 0, last7Days: 0 },
    requirements: {
      dnsName: "archive.example.test",
      smtpPort: 25,
      exchangePort: 25,
      portMismatch: false,
      tlsConfigured: true,
      maxMessageMegabytes: 150,
    },
    docsUrl: null,
    ...overrides,
  };
}

describe("JournalSection setup help", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <JournalSection />
          </I18nextProvider>
        </QueryClientProvider>,
      );
    });
    for (let attempt = 0; attempt < 20 && !container.querySelector("#journal-address"); attempt++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
    }
  }

  const slot = (name: string) => container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label),
    );
  const setupCalls = () => apiFetch.mock.calls.filter(([path]) => path === "/archive/journal");

  function type(input: HTMLInputElement, value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
        input,
        value,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("writes the commands only for a valid mailbox for undeliverable reports", async () => {
    apiFetch.mockResolvedValue(setup());
    await mount();
    const block = slot("journal-powershell") as HTMLElement;
    expect(block.querySelector("pre")).toBeNull();
    expect(slot("journal-powershell-waiting")).not.toBeNull();
    const input = block.querySelector("input") as HTMLInputElement;

    type(input, "someone@archive.example.test");
    expect(block.querySelector('[role="alert"]')?.textContent).toContain("at the journal host");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(block.querySelector("pre")).toBeNull();

    type(input, "journal-ndr@contoso.example");
    expect(block.querySelector('[role="alert"]')).toBeNull();
    const script = block.querySelector("pre")?.textContent ?? "";
    expect(script).toContain(
      "Set-TransportConfig -JournalingReportNdrTo 'journal-ndr@contoso.example'",
    );
    expect(script).toContain(`New-JournalRule -Name 'Restow' -JournalEmailAddress '${ADDRESS}'`);
    expect(
      block.querySelector('button[aria-label="Copy: Exchange Online PowerShell"]'),
    ).not.toBeNull();
  });

  it("asks every 5 seconds while waiting for a report, and stops once one arrived", async () => {
    let lastReportAt: string | null = "2026-10-20T08:00:00.000Z";
    apiFetch.mockImplementation(() => Promise.resolve(setup({ lastReportAt })));
    await mount();
    const before = setupCalls().length;
    await act(async () => {
      button("Wait for a report")?.click();
    });
    expect(slot("journal-first-report")?.querySelector('[data-state="waiting"]')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(setupCalls().length).toBe(before + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(setupCalls().length).toBe(before + 2);

    // A report arrives (after the wait began): the next answer says so and the polling stops.
    lastReportAt = new Date(Date.now()).toISOString();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    // The query hands its new answer to React on a timer of its own (setTimeout 0): let the
    // clock run on in small steps until the page shows it, instead of hoping it fell inside
    // the 5 seconds above.
    const arrived = () => slot("journal-first-report")?.querySelector('[data-state="arrived"]');
    for (let step = 0; step < 50 && !arrived(); step++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
    }
    expect(arrived()).not.toBeNull();
    const done = setupCalls().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(setupCalls().length).toBe(done);
  });

  it("names the first report when the API knows it", async () => {
    apiFetch.mockResolvedValue(
      setup({ status: "receiving", firstReportAt: "2026-10-01T08:00:00.000Z" }),
    );
    await mount();
    expect(slot("journal-first-report")?.textContent).toContain("First report:");
  });
});
