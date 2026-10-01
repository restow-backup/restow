// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { JournalSetup } from "./api";
import { JournalSection } from "./journal-section";

/**
 * The journal section in a real DOM: the address is copyable, and rotating it
 * asks first (the old address stops working at once), does nothing on
 * Cancel, and on confirmation shows the new address.
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", role: "tenant_admin" },
    isProviderAdmin: false,
    extensions: { edition: "business" },
  }),
}));

const copyToClipboard = vi.fn().mockResolvedValue(undefined);
vi.mock("@/components/kit/clipboard", () => ({
  copyToClipboard: (value: string) => copyToClipboard(value),
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

function setup(token: string, overrides: Partial<JournalSetup> = {}): JournalSetup {
  return {
    address: `journal+${token}@archive.example.test`,
    localPart: `journal+${token}`,
    hostname: "archive.example.test",
    hostnameIssue: null,
    status: "no_reports",
    receiver: { listening: true, reason: null },
    lastReportAt: null,
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

const OLD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("JournalSection actions", () => {
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
      await flush();
    });
    for (let attempt = 0; attempt < 10 && !container.querySelector("#journal-address"); attempt++) {
      await act(async () => {
        await flush();
      });
    }
  }

  const address = () => container.querySelector("#journal-address")?.textContent;
  const button = (label: string, within: ParentNode = document.body) =>
    [...within.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label),
    );
  const dialog = () => document.body.querySelector('[role="alertdialog"]');
  const posts = () =>
    apiFetch.mock.calls.filter(([, init]) => (init as { method?: string })?.method === "POST");

  async function click(element: Element | undefined) {
    await act(async () => {
      (element as HTMLElement).click();
      await flush();
    });
  }

  beforeEach(() => {
    apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === "/archive/journal/rotate" && init?.method === "POST") {
        return Promise.resolve(setup(NEW));
      }
      if (path === "/archive/journal") {
        return Promise.resolve(setup(OLD));
      }
      return Promise.reject(new Error(`unexpected request ${path}`));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the address and copies exactly that address", async () => {
    await mount();
    expect(address()).toBe(`journal+${OLD}@archive.example.test`);
    await click(container.querySelector('[aria-label="Copy journal address"]') ?? undefined);
    expect(copyToClipboard).toHaveBeenCalledWith(`journal+${OLD}@archive.example.test`);
  });

  it("asks before rotating and does nothing when cancelled", async () => {
    await mount();
    await click(button("Rotate address", container));
    expect(dialog()?.textContent).toContain("Rotate the journal address?");
    expect(dialog()?.textContent).toContain("stops working at once");
    expect(posts()).toHaveLength(0);

    await click(button("Cancel", dialog() ?? document.body));
    expect(dialog()).toBeNull();
    expect(posts()).toHaveLength(0);
    expect(address()).toBe(`journal+${OLD}@archive.example.test`);
  });

  it("rotates on confirmation and shows the new address", async () => {
    await mount();
    await click(button("Rotate address", container));
    await click(dialog()?.querySelector('button[type="submit"]') ?? undefined);
    for (
      let attempt = 0;
      attempt < 10 && address() === `journal+${OLD}@archive.example.test`;
      attempt++
    ) {
      await act(async () => {
        await flush();
      });
    }
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.[0]).toBe("/archive/journal/rotate");
    expect(address()).toBe(`journal+${NEW}@archive.example.test`);
    expect(dialog()).toBeNull();
  });

  it("keeps the dialog open with the cause when rotating fails", async () => {
    await mount();
    apiFetch.mockImplementation((path: string, init?: { method?: string }) =>
      path === "/archive/journal/rotate" && init?.method === "POST"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(setup(OLD)),
    );
    await click(button("Rotate address", container));
    await click(dialog()?.querySelector('button[type="submit"]') ?? undefined);
    for (let attempt = 0; attempt < 10; attempt++) {
      await act(async () => {
        await flush();
      });
    }
    expect(dialog()?.textContent).toContain("The action could not be completed");
    expect(address()).toBe(`journal+${OLD}@archive.example.test`);
  });
});
