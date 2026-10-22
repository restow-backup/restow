// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { ForwardingAccount, ForwardingOverview } from "./api";
import { ForwardingSection } from "./forwarding-section";

/**
 * Forwarding to the archive (0.4.4): each account's own address, issued on request, renewed
 * after a question; its status; and the provider instructions built from the addresses. The
 * Google Workspace tab asks for the tenant's journal address only once it is opened.
 */

let edition = "business";
vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", role: "tenant_admin" },
    isProviderAdmin: false,
    extensions: { edition },
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

function account(over: Partial<ForwardingAccount>): ForwardingAccount {
  return {
    objectId: "po-info",
    displayName: null,
    login: "info@hoster.example",
    captureKind: "imap",
    address: "archive+aaaa@archive.example.test",
    addressCreatedAt: "2026-10-01T00:00:00.000Z",
    lastCopyAt: "2026-10-22T09:00:00.000Z",
    counts: { last24Hours: 5, last7Days: 30 },
    status: "receiving",
    ...over,
  };
}

const OVERVIEW: ForwardingOverview = {
  hostname: "archive.example.test",
  hostnameIssue: null,
  receiver: { listening: true, reason: null },
  items: [
    account({}),
    account({
      objectId: "po-sales",
      login: "sales@hoster.example",
      address: null,
      addressCreatedAt: null,
      lastCopyAt: null,
      counts: { last24Hours: 0, last7Days: 0 },
      status: "no_address",
    }),
    account({
      objectId: "po-team",
      login: "team@workspace.example",
      captureKind: "google",
      address: null,
      status: "stale",
    }),
  ],
  nextCursor: null,
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ForwardingSection", () => {
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
            <ForwardingSection />
          </I18nextProvider>
        </QueryClientProvider>,
      );
      await flush();
    });
    for (let attempt = 0; attempt < 10 && !slot("forwarding-account"); attempt++) {
      await act(async () => {
        await flush();
      });
    }
  }

  const slot = (name: string) => container?.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  const rows = () => [...container.querySelectorAll('[data-slot="forwarding-account"]')];
  async function click(element: Element | null | undefined) {
    await act(async () => {
      (element as HTMLElement).click();
      await flush();
    });
  }
  /** Radix tabs switch on mouse down, not on click. */
  async function openTab(label: string) {
    const tab = [...container.querySelectorAll('[role="tab"]')].find(
      (candidate) => candidate.textContent === label,
    ) as HTMLElement;
    await act(async () => {
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      await flush();
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      await act(async () => {
        await flush();
      });
    }
  }

  beforeEach(() => {
    edition = "business";
    apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === "/archive/forwarding") return Promise.resolve(OVERVIEW);
      if (path === "/archive/forwarding/po-sales/address" && init?.method === "POST") {
        return Promise.resolve(
          account({
            objectId: "po-sales",
            login: "sales@hoster.example",
            address: "archive+bbbb@archive.example.test",
            lastCopyAt: null,
            counts: { last24Hours: 0, last7Days: 0 },
            status: "no_copies",
          }),
        );
      }
      if (path === "/archive/forwarding/po-info/rotate" && init?.method === "POST") {
        return Promise.resolve(account({ address: "archive+cccc@archive.example.test" }));
      }
      if (path === "/archive/journal") {
        return Promise.resolve({ address: "journal+tttt@archive.example.test" });
      }
      return Promise.reject(new Error(`unexpected request ${path}`));
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("lists each account with its address and status, and the Google account by routing", async () => {
    await mount();
    const [info, sales, team] = rows();
    expect(info?.textContent).toContain("archive+aaaa@archive.example.test");
    expect(info?.textContent).toContain("Copies arriving");
    expect(info?.textContent).toContain("5 in 24 hours, 30 in 7 days");
    expect(sales?.textContent).toContain("No address yet");
    expect(team?.textContent).toContain("Routing rule to the tenant's journal address");
    expect(team?.textContent).toContain("No copy for over 24 hours");
    // Nothing asked for the tenant's journal address yet.
    expect(apiFetch.mock.calls.some(([path]) => path === "/archive/journal")).toBe(false);
  });

  it("issues an account's address on request", async () => {
    await mount();
    await click(
      container.querySelector(
        'button[aria-label="Create the archive address of sales@hoster.example"]',
      ),
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      await act(async () => {
        await flush();
      });
    }
    expect(apiFetch).toHaveBeenCalledWith("/archive/forwarding/po-sales/address", {
      method: "POST",
    });
    expect(rows()[1]?.textContent).toContain("archive+bbbb@archive.example.test");
  });

  it("renews an address only after the question", async () => {
    await mount();
    await click(
      container.querySelector(
        'button[aria-label="Renew the archive address of info@hoster.example"]',
      ),
    );
    const dialog = document.body.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("stops working at once");
    expect(
      apiFetch.mock.calls.some(([, init]) => (init as { method?: string })?.method === "POST"),
    ).toBe(false);
    await click(
      [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Renew address"),
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      await act(async () => {
        await flush();
      });
    }
    expect(apiFetch).toHaveBeenCalledWith("/archive/forwarding/po-info/rotate", { method: "POST" });
    expect(rows()[0]?.textContent).toContain("archive+cccc@archive.example.test");
  });

  it("builds the Postfix map, the mailcow entries and the Sieve rule from the addresses", async () => {
    await mount();
    const instructions = slot("forwarding-instructions") as HTMLElement;
    const blocks = () => [...instructions.querySelectorAll("pre")].map((pre) => pre.textContent);
    expect(blocks()).toEqual([
      "info@hoster.example  archive+aaaa@archive.example.test",
      "recipient_bcc_maps = hash:/etc/postfix/archive_bcc\nsender_bcc_maps = hash:/etc/postfix/archive_bcc",
      "postmap /etc/postfix/archive_bcc\npostfix reload",
    ]);
    expect(instructions.textContent).toContain("Accounts without an address are not included yet.");
    await openTab("mailcow");
    expect(blocks()[0]).toContain(
      "sender     info@hoster.example  ->  archive+aaaa@archive.example.test",
    );
    await openTab("Sieve");
    expect(blocks()[0]).toBe(
      'require ["copy"];\nredirect :copy "archive+aaaa@archive.example.test";',
    );
  });

  it("asks for the tenant's journal address once the Google Workspace tab is opened", async () => {
    await mount();
    await openTab("Google Workspace");
    expect(apiFetch.mock.calls.some(([path]) => path === "/archive/journal")).toBe(true);
    expect(slot("forwarding-google")?.querySelector("pre")?.textContent).toBe(
      "journal+tttt@archive.example.test",
    );
  });

  it("shows nothing below Business", async () => {
    edition = "community";
    await mount();
    expect(container.textContent).toBe("");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
