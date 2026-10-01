// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n.js";
import { ArchivePage } from "./archive-page.js";

/**
 * The archive page's export action in a real DOM: the whole current search
 * when nothing is ticked, the ticked mails otherwise, and the date column
 * showing when the mail was sent once the API reports it.
 */

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigate };
});
vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", role: "tenant_admin" },
    isProviderAdmin: false,
  }),
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: (path: string, init?: unknown) => apiFetch(path, init) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const items = [
  {
    id: "a1",
    subject: "Invoice 2026-0412",
    from: "billing@example.test",
    to: ["office@example.test"],
    cc: [],
    receivedAt: "2026-03-05T10:00:00.000Z",
    sentAt: "2026-03-01T08:30:00.000Z",
    hasAttachment: true,
    sizeBytes: 2048,
    flags: [],
    source: "file_import",
  },
  {
    id: "a2",
    subject: "Meeting notes",
    from: "lena@example.test",
    to: ["office@example.test"],
    cc: [],
    receivedAt: "2026-03-06T10:00:00.000Z",
    hasAttachment: false,
    sizeBytes: 1024,
    flags: [],
    source: "journal",
  },
];

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ArchivePage export", () => {
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
            <ArchivePage />
          </I18nextProvider>
        </QueryClientProvider>,
      );
      await flush();
    });
    for (let attempt = 0; attempt < 10 && !container.querySelector("tbody tr"); attempt += 1) {
      await act(async () => {
        await flush();
      });
    }
  }

  const text = () => container.textContent ?? "";
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label),
    );
  const rowCheckboxes = () => [
    ...container.querySelectorAll<HTMLButtonElement>("tbody [role=checkbox]"),
  ];

  async function click(element: Element | undefined) {
    await act(async () => {
      (element as HTMLElement).click();
      await flush();
    });
  }

  /** The dialog fetches the formats when it opens; wait until they are shown. */
  async function formatsLoaded() {
    for (
      let attempt = 0;
      attempt < 10 && !container.querySelector("#export-format-eml_zip");
      attempt += 1
    ) {
      await act(async () => {
        await flush();
      });
    }
  }

  beforeEach(() => {
    apiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/archive/search")) {
        return Promise.resolve({ items, total: 42, limit: 50, offset: 0 });
      }
      if (path === "/exports/formats") {
        return Promise.resolve({
          formats: [
            { id: "eml_zip", available: true },
            { id: "mbox", available: true },
            { id: "msg_zip", available: false },
            { id: "pst", available: false, planned: true },
          ],
        });
      }
      if (path === "/exports") {
        return Promise.resolve({ id: "exp-9", jobId: "job-9", status: "queued" });
      }
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows the sent date when the API reports one and the received date otherwise", async () => {
    await mount();
    const dates = [...container.querySelectorAll("tbody time")].map((time) =>
      time.getAttribute("datetime"),
    );
    expect(dates).toEqual(["2026-03-01T08:30:00.000Z", "2026-03-06T10:00:00.000Z"]);
    expect(text()).toContain("Date");
  });

  it("exports the whole current search when nothing is ticked", async () => {
    await mount();
    await click(button("Export all results"));
    expect(text()).toContain("All mails of the current search (42 results)");
    expect(text()).toContain("From the archive");
    await formatsLoaded();

    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });
    const post = apiFetch.mock.calls.find(([path]) => path === "/exports");
    expect(post?.[1]).toMatchObject({
      method: "POST",
      body: { origin: "archive", selection: { filter: {} }, format: "eml_zip" },
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/exports/exp-9" });
  });

  it("puts the search text and attachment filter into the export", async () => {
    await mount();
    await act(async () => {
      setValue(
        container.querySelector<HTMLInputElement>(
          "input[placeholder^='Search']",
        ) as HTMLInputElement,
        "invoice",
      );
      await flush();
    });
    await click(container.querySelector("#archive-has-attachment") ?? undefined);
    await click(button("Export all results"));
    expect(text()).toContain("Search: “invoice”");
    expect(text()).toContain("Only mails with attachments");
  });

  it("exports only the ticked mails", async () => {
    await mount();
    await click(rowCheckboxes()[1]);
    expect(button("Export selected (1)")).toBeDefined();
    await click(rowCheckboxes()[0]);
    await click(button("Export selected (2)"));
    expect(text()).toContain("2 archived mails selected");
    await formatsLoaded();

    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });
    const post = apiFetch.mock.calls.find(([path]) => path === "/exports");
    expect(post?.[1]).toMatchObject({
      body: { origin: "archive", selection: { itemIds: ["a1", "a2"] }, format: "eml_zip" },
    });
  });

  it("ticks everything on the page from the header checkbox", async () => {
    await mount();
    const header = container.querySelector<HTMLButtonElement>("thead [role=checkbox]");
    await click(header ?? undefined);
    expect(rowCheckboxes().every((box) => box.getAttribute("aria-checked") === "true")).toBe(true);
    expect(button("Export selected (2)")).toBeDefined();
  });
});
