// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { MailExport } from "./api";
import { ExportsPage } from "./exports-page";

import { ApiError } from "@/lib/api";

/**
 * The export history: one row per export with where it came from, its
 * format, status, size, how long the link lasts, and a download that is
 * offered only while the file exists.
 */

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({ to, children, ...rest }: { to: string; children?: React.ReactNode }) => (
      <a href={String(to)} {...rest}>
        {children}
      </a>
    ),
  };
});
let role = "tenant_admin";
vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", name: "Contoso", role },
    isProviderAdmin: false,
  }),
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});

const fetchExports = vi.fn();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchExportList: async () => ({ items: await fetchExports(), ttlHours: 6 }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const NOW = new Date("2026-09-30T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function item(patch: Partial<MailExport> = {}): MailExport {
  return {
    id: "exp-1",
    jobId: "job-1",
    origin: "snapshot",
    format: "eml_zip",
    status: "completed",
    object: {
      id: "o-1",
      kind: "mailbox",
      externalId: "anna@example.test",
      displayName: "Anna Berger",
    },
    snapshotId: "snap-1",
    selection: { items: 12, folders: 2 },
    fileName: "anna.zip",
    fileSize: 5_242_880,
    sha256: "a".repeat(64),
    createdAt: at(-HOUR),
    completedAt: at(-30 * MINUTE),
    expiresAt: at(23 * HOUR + 14 * MINUTE + 30_000),
    available: true,
    progress: null,
    phase: null,
    actor: { userId: "u-1", name: "Lena Schneider", email: "lena@example.test" },
    impersonated: false,
    ...patch,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ExportsPage", () => {
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
            <ExportsPage />
          </I18nextProvider>
        </QueryClientProvider>,
      );
      await flush();
    });
    for (let attempt = 0; attempt < 10 && container.querySelector(".animate-pulse"); attempt += 1) {
      await act(async () => {
        await flush();
      });
    }
  }

  const text = () => container.textContent ?? "";
  const rows = () => [...container.querySelectorAll("tbody tr")];

  beforeEach(() => {
    role = "tenant_admin";
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("lists every export with source, format, status, size and link validity", async () => {
    fetchExports.mockResolvedValue([
      item(),
      item({
        id: "exp-2",
        origin: "archive",
        object: null,
        format: "mbox",
        selection: { items: null, folders: null },
        impersonated: false,
        fileSize: 1_048_576,
      }),
      item({
        id: "exp-3",
        status: "active",
        available: false,
        expiresAt: null,
        fileSize: null,
        progress: { total: 100, done: 25, failed: 0, bytes: 1, etaSeconds: null },
      }),
      item({ id: "exp-4", available: false, expiresAt: at(-HOUR), impersonated: true }),
    ]);
    await mount();
    expect(rows()).toHaveLength(4);

    const [done, archive, running, expired] = rows() as HTMLElement[];
    expect(done?.textContent).toContain("Anna Berger");
    expect(done?.textContent).toContain("2 folders, 12 items");
    expect(done?.textContent).toContain("EML (ZIP)");
    expect(done?.textContent).toContain("Completed");
    expect(done?.textContent).toContain("5 MB");
    expect(done?.textContent).toContain("in 23 h 14 min");
    const link = done?.querySelector("a[download]");
    expect(link?.getAttribute("href")).toBe("/api/v1/exports/exp-1/download?tenant=t-1");

    expect(archive?.textContent).toContain("Archive");
    expect(archive?.textContent).toContain("All search results");
    expect(archive?.textContent).toContain("MBOX");

    expect(running?.textContent).toContain("Running");
    expect(running?.textContent).toContain("25 of 100 mails");
    expect(running?.querySelector("a[download]")).toBeNull();
    expect(
      [...(running?.querySelectorAll("button") ?? [])].some((b) =>
        b.textContent?.includes("Cancel"),
      ),
    ).toBe(true);

    expect(expired?.textContent).toContain("Expired");
    expect(expired?.textContent).toContain("Admin export");
    expect(expired?.querySelector("a[download]")).toBeNull();
    const disabled = [...(expired?.querySelectorAll("button") ?? [])].find((b) =>
      b.textContent?.includes("Download"),
    );
    expect(disabled?.disabled).toBe(true);
  });

  it("opens an export's page when its row is clicked", async () => {
    fetchExports.mockResolvedValue([item()]);
    await mount();
    await act(async () => {
      (rows()[0] as HTMLElement).click();
      await flush();
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/exports/exp-1" });
  });

  it("points to the restore explorer and, for admins, the archive when there is nothing yet", async () => {
    fetchExports.mockResolvedValue([]);
    await mount();
    expect(text()).toContain("No exports yet");
    expect(text()).toContain("Export from backups");
    expect(text()).toContain("Export from the archive");
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/restore");
    expect(hrefs).toContain("/archive");
  });

  it("does not offer the archive to people who cannot export from it", async () => {
    role = "tenant_user";
    fetchExports.mockResolvedValue([]);
    await mount();
    expect(text()).toContain("Export from backups");
    expect(text()).not.toContain("Export from the archive");
    // Nor does the empty state point there.
    expect(text()).not.toContain("or the archive");
  });

  it("names the download period the server is set to, not a fixed 24 hours", async () => {
    fetchExports.mockResolvedValue([]);
    await mount();
    expect(text()).toContain("Finished files can be downloaded for 6 hours.");
    expect(text()).not.toContain("24 hours");
  });

  it("explains when the list cannot be loaded", async () => {
    fetchExports.mockRejectedValue(new ApiError(500, null, "boom"));
    await mount();
    expect(text()).toContain("The exports could not be loaded.");
  });
});
