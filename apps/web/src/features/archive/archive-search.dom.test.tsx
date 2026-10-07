// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";

import "./i18n.js";
import { ArchivePage } from "./archive-page.js";
import { SEARCH_DEBOUNCE_MS } from "./presenters.js";

/**
 * The archive search as a person uses it: one (audited) search per pause in
 * typing, an honest error instead of "nothing archived", pages with
 * "51–100 of 120", the sender and date filters, the reading pane with the
 * `.eml` download, the storage protection and the chain check's findings.
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
vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", role: "tenant_admin" },
    isProviderAdmin: false,
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

function row(index: number) {
  return {
    id: `item-${index}`,
    subject: `Mail ${index}`,
    from: "sender@example.test",
    to: [],
    cc: [],
    receivedAt: "2026-03-01T10:00:00.000Z",
    sentAt: null,
    hasAttachment: false,
    sizeBytes: 1024,
    flags: [],
    source: "file_import",
  };
}

const TOTAL = 120;

function searchResponse(path: string) {
  const offset = Number(new URLSearchParams(path.split("?")[1] ?? "").get("offset") ?? "0");
  const count = Math.min(50, TOTAL - offset);
  return {
    items: Array.from({ length: count }, (_, index) => row(offset + index + 1)),
    total: TOTAL,
    limit: 50,
    offset,
  };
}

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

const searches = () =>
  apiFetch.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.startsWith("/archive/search"));

describe("ArchivePage search", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function settle(rounds = 10) {
    for (let attempt = 0; attempt < rounds; attempt += 1) {
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
    await settle();
  }

  const text = () => container.textContent ?? "";
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent?.includes(label) || candidate.getAttribute("aria-label") === label,
    );
  async function click(element: Element | null | undefined) {
    await act(async () => {
      (element as HTMLElement).click();
      await flush();
    });
    await settle();
  }

  beforeEach(() => {
    apiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/archive/search")) {
        return Promise.resolve(searchResponse(path));
      }
      if (path === "/storage/targets") {
        return Promise.resolve({
          items: [],
          installationDefault: {
            inUse: true,
            kind: "local",
            location: "/data",
            hasCopy: false,
            copyLocation: null,
            misconfigured: false,
          },
          tenantHasData: true,
          canManageLocal: true,
        });
      }
      if (path.endsWith("/preview")) {
        return Promise.resolve({
          previewable: true,
          body: { kind: "text", content: "Hello from the archive" },
          headers: {
            subject: "Mail 2",
            from: "sender@example.test",
            to: ["office@example.test"],
            cc: [],
            date: "2026-03-01T10:00:00.000Z",
            messageId: "<m@x>",
          },
          attachments: [
            {
              id: "a1",
              filename: "invoice.pdf",
              contentType: "application/pdf",
              size: 10,
              inline: false,
            },
          ],
        });
      }
      if (path.startsWith("/archive/items/")) {
        return Promise.resolve({
          id: "item-2",
          tenantId: "t-1",
          receivedAt: "2026-03-01T10:00:00.000Z",
          itemHash: "ab".repeat(32),
          chainHash: "cd".repeat(32),
          size: 1024,
          envelope: { sender: null, subject: "Mail 2", messageId: "<m@x>", recipients: [] },
          flags: ["carrier-pigeon"],
          source: "file_import",
          retentionUntil: null,
        });
      }
      if (path.startsWith("/archive/chain/verify")) {
        return Promise.resolve({
          ok: false,
          checkedAt: "2026-10-07T10:00:00.000Z",
          checked: 120,
          brokenAt: {
            index: 41,
            position: 42,
            itemId: "item-42",
            subject: "Quarterly report",
            receivedAt: "2026-03-01T10:00:00.000Z",
            expectedChainHash: "a",
            actualChainHash: "b",
          },
          anchors: { checked: 0, latestDate: null, unsealed: 120, failed: null },
          content: { requested: 0, checked: 0, notRecorded: 0, failures: [] },
        });
      }
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("searches once typing pauses, not per keystroke", async () => {
    await mount();
    expect(searches()).toHaveLength(1);
    const input = container.querySelector<HTMLInputElement>("input[type=search]");
    for (const value of ["R", "Re", "Rec", "Rech"]) {
      await act(async () => {
        setValue(input as HTMLInputElement, value);
        await flush(20);
      });
    }
    expect(searches()).toHaveLength(1);
    await act(async () => {
      await flush(SEARCH_DEBOUNCE_MS + 50);
    });
    await settle();
    expect(searches()).toHaveLength(2);
    expect(searches()[1]).toContain("q=Rech");
  });

  it("searches at once on Enter", async () => {
    await mount();
    const input = container.querySelector<HTMLInputElement>("input[type=search]");
    await act(async () => {
      setValue(input as HTMLInputElement, "invoice");
      container
        .querySelector("form[data-slot=archive-search]")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });
    await settle();
    expect(searches().some((path) => path.includes("q=invoice"))).toBe(true);
  });

  it("says the search failed instead of claiming the archive is empty", async () => {
    apiFetch.mockImplementation((path: string) =>
      path.startsWith("/archive/search")
        ? Promise.reject(new ApiError(500, null, "Internal Server Error"))
        : Promise.resolve({}),
    );
    await mount();
    expect(text()).toContain("The archive search failed");
    expect(text()).not.toContain("Nothing has been archived");
  });

  it("pages through the results and says which rows are shown", async () => {
    await mount();
    expect(text()).toContain("1–50 of 120");
    await click(button("Next page"));
    expect(searches().at(-1)).toContain("offset=50");
    expect(text()).toContain("51–100 of 120");
    await click(button("Next page"));
    expect(text()).toContain("101–120 of 120");
    expect(button("Next page")?.hasAttribute("disabled")).toBe(true);
  });

  it("filters by sender and by date", async () => {
    await mount();
    await act(async () => {
      setValue(container.querySelector("#archive-from") as HTMLInputElement, "cfo");
      setValue(container.querySelector("#archive-date-from") as HTMLInputElement, "2026-01-01");
      await flush();
    });
    await settle();
    const last = new URLSearchParams(searches().at(-1)?.split("?")[1] ?? "");
    expect(last.get("from")).toBe("cfo");
    expect(last.get("dateFrom")).toBeTruthy();
    expect(last.get("offset")).toBe("0");
  });

  it("reads a message in place and offers its original as .eml", async () => {
    await mount();
    expect(text()).toContain("Select a message in the list to read it.");
    await click(container.querySelectorAll("tbody tr")[1]);
    expect(text()).toContain("Hello from the archive");
    expect(text()).toContain("invoice.pdf");
    expect(text()).toContain("Attachments are included in the .eml file.");
    // An unknown flag is named as a flag, not shown as a bare code.
    expect(text()).toContain("Flag carrier-pigeon");
    const download = container.querySelector<HTMLAnchorElement>("[data-slot=archive-download]");
    expect(download?.getAttribute("href")).toBe("/api/v1/archive/items/item-2/download?tenant=t-1");
  });

  it("says that a filesystem archive is protected by the application only", async () => {
    await mount();
    const notice = container.querySelector("[data-archive-protection]");
    expect(notice?.getAttribute("data-archive-protection")).toBe("filesystem");
    expect(notice?.textContent).toContain("Anyone with access to the server or the storage");
  });

  it("names a chain break by position and subject and opens that message", async () => {
    await mount();
    await click(button("Verify chain"));
    expect(searches().length).toBeGreaterThan(0);
    expect(text()).toContain("Chain broken at entry 42 of 120: “Quarterly report”");
    expect(text()).toContain("Daily anchors: none sealed yet.");
    expect(text()).toContain("Content: not read.");
    await click(container.querySelector("[data-open-item=item-42]"));
    expect(apiFetch.mock.calls.some(([path]) => path === "/archive/items/item-42")).toBe(true);
  });

  it("reads a sample of the content back on request", async () => {
    await mount();
    await click(button("Verify chain and a sample of the content"));
    expect(
      apiFetch.mock.calls.some(([path]) => path === "/archive/chain/verify?contentSample=100"),
    ).toBe(true);
  });
});
