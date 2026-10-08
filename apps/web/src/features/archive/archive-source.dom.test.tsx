// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n.js";
import type { ArchiveSource } from "./api.js";
import { ArchivePage } from "./archive-page.js";

/**
 * The capture source of archived mail, as the archive page shows it: a column
 * in the list and a line in the detail, each with the real path (journal,
 * Graph sync, IMAP sync, imported mail file). Mail captured by an import is
 * never called a journal item.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    // Links render as plain anchors: these tests render without a <RouterProvider>.
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

const SOURCES: ArchiveSource[] = ["journal", "graph_sync", "imap_sync", "file_import"];

const items = SOURCES.map((source, index) => ({
  id: `item-${source}`,
  subject: `Mail ${index + 1}`,
  from: "sender@example.test",
  to: ["office@example.test"],
  cc: [],
  receivedAt: `2026-03-0${index + 1}T10:00:00.000Z`,
  sentAt: null,
  hasAttachment: false,
  sizeBytes: 1024,
  flags: [],
  source,
}));

function detail(source: ArchiveSource) {
  return {
    id: `item-${source}`,
    tenantId: "t-1",
    receivedAt: "2026-03-01T10:00:00.000Z",
    itemHash: "ab".repeat(32),
    chainHash: "cd".repeat(32),
    size: 1024,
    envelope: {
      sender: "sender@example.test",
      subject: "Mail",
      messageId: "<m@x>",
      recipients: [],
    },
    flags: [],
    source,
    retentionUntil: null,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ArchivePage capture source", () => {
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

  const sourceCells = () =>
    [...container.querySelectorAll("tbody tr")].map(
      (row) => row.querySelectorAll("td")[4]?.textContent,
    );
  const detailSource = () => {
    const term = [...container.querySelectorAll("dt")].find(
      (candidate) => candidate.textContent === i18n.t("archive:detail.source"),
    );
    return term?.nextElementSibling?.textContent;
  };

  async function select(row: number) {
    await act(async () => {
      (container.querySelectorAll("tbody tr")[row] as HTMLElement).click();
      await flush();
    });
    for (let attempt = 0; attempt < 10 && detailSource() === undefined; attempt += 1) {
      await act(async () => {
        await flush();
      });
    }
  }

  beforeEach(() => {
    apiFetch.mockImplementation((path: string) => {
      if (path.startsWith("/archive/search")) {
        return Promise.resolve({ items, total: items.length, limit: 50, offset: 0 });
      }
      if (path.endsWith("/preview")) {
        return Promise.resolve({
          previewable: false,
          reason: "too-large",
          headers: { subject: "Mail", from: null, to: [], cc: [], date: null, messageId: null },
          attachments: [],
        });
      }
      const match = /^\/archive\/items\/item-(.+)$/.exec(path);
      if (match) {
        return Promise.resolve(detail(match[1] as ArchiveSource));
      }
      return Promise.resolve({});
    });
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
  });

  it("shows the real capture path of every item in the list", async () => {
    await mount();
    expect(container.textContent).toContain("Source");
    expect(sourceCells()).toEqual(["Journal", "Graph sync", "IMAP sync", "Import"]);
  });

  it("calls an imported mail file an import in the detail, not an Exchange journal item", async () => {
    await mount();
    await select(3);
    expect(detailSource()).toBe("Mail file import");
    expect(container.textContent).not.toContain("Exchange Online journal");
  });

  it("names each other path in the detail as well", async () => {
    await mount();
    const expected = ["Exchange Online journal", "Graph sync", "IMAP sync", "Mail file import"];
    for (const [row, label] of expected.entries()) {
      await select(row);
      expect(detailSource()).toBe(label);
    }
  });

  it("is translated to German", async () => {
    await i18n.changeLanguage("de");
    await mount();
    expect(container.textContent).toContain("Quelle");
    expect(sourceCells()).toEqual(["Journal", "Graph-Sync", "IMAP-Sync", "Import"]);
    await select(3);
    expect(detailSource()).toBe("Mail-Datei-Import");
  });

  it("shows the code of a source this version does not know instead of a wrong label", async () => {
    apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith("/archive/search")
          ? { items: [{ ...items[0], source: "carrier_pigeon" }], total: 1, limit: 50, offset: 0 }
          : {},
      ),
    );
    await mount();
    expect(sourceCells()).toEqual(["carrier_pigeon"]);
  });
});
