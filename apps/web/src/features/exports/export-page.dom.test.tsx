// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { MailExportDetail } from "./api";
import { ExportPage } from "./export-page";

import { ApiError } from "@/lib/api";

/**
 * The export page in a real DOM: a running export with its phase and
 * progress, a finished one with the file, checksum and expiry countdown, an
 * expired one whose download is disabled with an explanation, and the lists
 * of what was left out and what could not be exported.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({ to, children, ...rest }: { to: string; children?: React.ReactNode }) => (
      <a href={String(to)} {...rest}>
        {children}
      </a>
    ),
  };
});
vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", name: "Contoso", role: "tenant_admin" },
    isProviderAdmin: false,
  }),
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});

const fetchExport = vi.fn();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchExport: (id: string) => fetchExport(id) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const NOW = new Date("2026-09-30T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function detail(patch: Partial<MailExportDetail> = {}): MailExportDetail {
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
    fileName: "anna-berger-2026-09-30-1300.zip",
    fileSize: 5_242_880,
    sha256: "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
    createdAt: at(-2 * HOUR),
    completedAt: at(-(60 * MINUTE - 14 * MINUTE)),
    expiresAt: at(23 * HOUR + 14 * MINUTE + 30_000),
    available: true,
    progress: null,
    phase: null,
    actor: { userId: "u-1", name: "Lena Schneider", email: "lena@example.test" },
    impersonated: false,
    reason: null,
    errorMessage: null,
    report: {
      messages: 1204,
      folders: 9,
      bytes: 10_485_760,
      failed: 0,
      skipped: { calendar: 0, contacts: 0, other: 0 },
      items: [],
    },
    failures: [],
    ...patch,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ExportPage", () => {
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
            <ExportPage exportId="exp-1" />
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
  const downloadLink = () =>
    [...container.querySelectorAll("a")].find((link) => link.textContent?.includes("Download"));
  const downloadButton = () =>
    [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Download"),
    );

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows a running export with its phase, progress and a way to cancel", async () => {
    fetchExport.mockResolvedValue(
      detail({
        status: "active",
        phase: "writing",
        fileName: null,
        fileSize: null,
        sha256: null,
        completedAt: null,
        expiresAt: null,
        available: false,
        report: null,
        progress: { total: 40, done: 12, failed: 1, bytes: 2_097_152, etaSeconds: 120 },
        failures: [{ itemRef: "Inbox/17.eml", reason: "chunk is missing", attempts: 1 }],
      }),
    );
    await mount();
    expect(text()).toContain("Running");
    expect(text()).toContain("Writing the mails into the file");
    expect(text()).toContain("12 of 40 mails");
    expect(text()).toContain("1 mail failed");
    expect(text()).toContain("about 2 minutes left");
    expect(text()).toContain("Inbox/17.eml");
    expect(text()).toContain("chunk is missing");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "33",
    );
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Cancel")),
    ).toBe(true);
    expect(downloadLink()).toBeUndefined();
    expect(downloadButton()).toBeUndefined();
  });

  it("shows a queued export as waiting", async () => {
    fetchExport.mockResolvedValue(
      detail({ status: "queued", fileName: null, report: null, available: false, expiresAt: null }),
    );
    await mount();
    expect(text()).toContain("Queued");
    expect(text()).toContain("Waiting for a free worker");
  });

  it("shows the finished file with checksum, countdown and a working download link", async () => {
    fetchExport.mockResolvedValue(detail());
    await mount();
    expect(text()).toContain("Completed");
    expect(text()).toContain("anna-berger-2026-09-30-1300.zip");
    expect(text()).toContain("EML files in a ZIP");
    expect(text()).toContain("EML files in a ZIP · 5 MB");
    expect(text()).toContain("3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b");
    expect(text()).toContain("The download link expires in 23 hours and 14 minutes.");
    expect(text()).toContain("1,204");
    expect(text()).toContain("10 MB");

    const link = downloadLink();
    expect(link?.getAttribute("href")).toBe("/api/v1/exports/exp-1/download?tenant=t-1");
    expect(link?.hasAttribute("download")).toBe(true);
    expect(container.querySelector("[role=alert]")).toBeNull();
    // A finished export cannot be cancelled any more.
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Cancel")).toBe(
      false,
    );
  });

  it("disables the download and explains why once the link has expired", async () => {
    fetchExport.mockResolvedValue(detail({ available: false, expiresAt: at(-HOUR) }));
    await mount();
    expect(text()).toContain("The download link has expired");
    expect(text()).toContain("Request the export again to get a new file.");
    expect(downloadLink()).toBeUndefined();
    expect(downloadButton()?.disabled).toBe(true);
    expect(text()).not.toContain("The download link expires in");
  });

  it("counts the link down while the page is open and disables the download when it runs out", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: NOW });
    fetchExport.mockResolvedValue(detail({ expiresAt: at(90_000) }));
    await mount();
    expect(text()).toContain("The download link expires in 1 minute.");
    expect(downloadLink()).toBeDefined();

    await act(async () => {
      vi.advanceTimersByTime(100_000);
    });
    expect(text()).toContain("The download link has expired");
    expect(text()).not.toContain("The download link expires in");
    expect(downloadLink()).toBeUndefined();
    expect(downloadButton()?.disabled).toBe(true);
  });

  it("says honestly what was left out because only mail is exported", async () => {
    fetchExport.mockResolvedValue(
      detail({
        report: {
          messages: 900,
          folders: 5,
          bytes: 1,
          failed: 0,
          skipped: { calendar: 1204, contacts: 1, other: 0 },
          items: [],
        },
      }),
    );
    await mount();
    expect(text()).toContain("Left out on purpose: exports contain mail only");
    expect(text()).toContain("1,204 calendar items were left out.");
    expect(text()).toContain("1 contact was left out.");
    expect(text()).not.toContain("other item");
  });

  it("lists the mails that could not be exported and marks the export as completed with issues", async () => {
    fetchExport.mockResolvedValue(
      detail({
        report: {
          messages: 998,
          folders: 5,
          bytes: 1,
          failed: 4,
          skipped: { calendar: 0, contacts: 0, other: 0 },
          items: [
            { ref: "Inbox/5.eml", reason: "data of the mail is missing" },
            { ref: "Sent/9.eml", reason: "checksum does not match" },
          ],
        },
      }),
    );
    await mount();
    expect(text()).toContain("Completed with issues");
    expect(text()).toContain("Mails that could not be exported");
    expect(text()).toContain("Inbox/5.eml");
    expect(text()).toContain("data of the mail is missing");
    expect(text()).toContain("Sent/9.eml");
    expect(text()).toContain("Showing 2 of 4.");
    // The file is still there for the mails that worked.
    expect(downloadLink()).toBeDefined();
  });

  it("explains a failed export and offers no download", async () => {
    fetchExport.mockResolvedValue(
      detail({
        status: "failed",
        fileName: null,
        fileSize: null,
        sha256: null,
        available: false,
        expiresAt: null,
        report: null,
        errorMessage: "The storage target is not reachable",
      }),
    );
    await mount();
    expect(text()).toContain("The export failed");
    expect(text()).toContain("The storage target is not reachable");
    expect(downloadLink()).toBeUndefined();
    expect(downloadButton()).toBeUndefined();
  });

  it("explains a classified failure in the reader's language, the engine's text only as a detail", async () => {
    fetchExport.mockResolvedValue(
      detail({
        status: "failed",
        fileName: null,
        sha256: null,
        available: false,
        expiresAt: null,
        report: null,
        errorMessage: "Error: ENOSPC: no space left on device, write",
        failure: {
          code: "storage.full",
          category: "storage",
          transient: false,
          retryable: true,
          params: {},
          technical: {},
          occurredAt: at(-HOUR),
          step: null,
          retry: null,
          steps: [],
          docsUrl: "https://example.test/docs",
        },
      }),
    );
    await mount();
    expect(text()).toContain("The export failed");
    expect(text()).toContain("The storage target is full");
    // The raw engine message is not the explanation: it sits in the collapsed technical details.
    const details = container.querySelector("details");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.textContent).toContain("ENOSPC");
  });

  it("leads back to where an expired export can be requested again", async () => {
    fetchExport.mockResolvedValue(detail({ available: false, expiresAt: at(-HOUR) }));
    await mount();
    const again = container.querySelector<HTMLAnchorElement>("[data-slot=export-again]");
    expect(again?.textContent).toContain("Request again in the explorer");
    expect(again?.getAttribute("href")).toContain("/restore");
  });

  it("shows a cancelled export without a file", async () => {
    fetchExport.mockResolvedValue(
      detail({
        status: "cancelled",
        fileName: null,
        sha256: null,
        available: false,
        expiresAt: null,
        report: null,
      }),
    );
    await mount();
    expect(text()).toContain("The export was cancelled");
    expect(text()).toContain("No file was kept.");
  });

  it("shows an admin export with its reason", async () => {
    fetchExport.mockResolvedValue(detail({ impersonated: true, reason: "INC-77 legal request" }));
    await mount();
    expect(text()).toContain("Admin export");
    expect(text()).toContain("INC-77 legal request");
    expect(text()).toContain("Anna Berger");
  });

  it("shows an archive export as coming from the archive", async () => {
    fetchExport.mockResolvedValue(
      detail({
        origin: "archive",
        object: null,
        snapshotId: null,
        selection: { items: null, folders: null },
      }),
    );
    await mount();
    expect(text()).toContain("Archive");
    expect(text()).toContain("All search results");
  });

  it("explains when the export cannot be loaded", async () => {
    fetchExport.mockRejectedValue(new ApiError(404, null, "gone"));
    await mount();
    expect(text()).toContain("The export could not be loaded.");
  });
});
