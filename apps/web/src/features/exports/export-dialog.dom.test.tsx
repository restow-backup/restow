// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { ExportFormatInfo } from "./api";
import { ExportDialog, type ExportDialogRequest } from "./export-dialog";

import type { Snapshot, SnapshotObject } from "@/features/restore/api";
import { selectionOf } from "@/features/restore/lib/selection";
import { ApiError } from "@/lib/api";

/**
 * A real DOM mount of the export dialog (react-dom/client + act, no React
 * Testing Library in this workspace): the formats come from the mocked API,
 * PST stays disabled with its honest alternative, MSG only shows when the
 * server can write it, somebody else's mailbox needs a reason, and the
 * request that leaves the dialog has the shape the API expects.
 */

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigate };
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

const fetchExportFormats = vi.fn();
const createExport = vi.fn();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchExportFormats: () => fetchExportFormats(),
    createExport: (request: unknown) => createExport(request),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const SHIPPED: ExportFormatInfo[] = [
  { id: "eml_zip", available: true },
  { id: "mbox", available: true },
  { id: "msg_zip", available: false, reason: "not evaluated yet" },
  { id: "pst", available: false, planned: true, reason: "planned for a later release" },
];

const object: SnapshotObject = {
  id: "o-1",
  kind: "mailbox",
  externalId: "anna@example.test",
  displayName: "Anna Berger",
  status: "active",
  sourceKind: "m365",
  ownerEmail: "anna@example.test",
  own: true,
  snapshotCount: 3,
  latestSnapshotId: "snap-1",
  latestSnapshotAt: "2026-09-30T10:00:00.000Z",
  readiness: "green",
};

const snapshot: Snapshot = {
  id: "snap-1",
  objectId: "o-1",
  sequence: 3,
  itemCount: 10,
  byteSize: 2048,
  startedAt: "2026-09-30T09:55:00.000Z",
  completedAt: "2026-09-30T10:00:00.000Z",
  createdAt: "2026-09-30T09:55:00.000Z",
};

const inbox = { path: "Mail/Inbox", kind: "folder" as const, itemId: null, subject: null, size: 0 };

function snapshotRequest(patch: { object?: SnapshotObject } = {}): ExportDialogRequest {
  return {
    origin: "snapshot",
    object: patch.object ?? object,
    snapshot,
    scope: { kind: "selection", selection: selectionOf(inbox) },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ExportDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();

  async function mount(request: ExportDialogRequest) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <ExportDialog request={request} onClose={onClose} />
          </I18nextProvider>
        </QueryClientProvider>,
      );
      await flush();
    });
    // The formats query resolves in a later tick.
    for (let attempt = 0; attempt < 10 && container.querySelector("output"); attempt += 1) {
      await act(async () => {
        await flush();
      });
    }
  }

  const text = () => container.textContent ?? "";
  const radio = (format: string) =>
    container.querySelector<HTMLButtonElement>(`#export-format-${format}`);

  async function type(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
    if (!element) throw new Error("field not found");
    await act(async () => {
      setValue(element, value);
      await flush();
    });
  }

  async function submit() {
    const form = container.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });
  }

  beforeEach(() => {
    fetchExportFormats.mockResolvedValue(SHIPPED);
    createExport.mockResolvedValue({ id: "exp-1", jobId: "job-1", status: "queued" });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("offers the formats from the API, with PST disabled and the honest alternative", async () => {
    await mount(snapshotRequest());
    expect(text()).toContain("EML files in a ZIP");
    expect(text()).toContain("MBOX");
    expect(text()).toContain("One .mbox file per folder inside a ZIP");
    expect(radio("eml_zip")?.getAttribute("aria-checked")).toBe("true");

    const pst = radio("pst");
    expect(pst).not.toBeNull();
    expect(pst?.disabled).toBe(true);
    expect(text()).toContain("Planned for a later release");
    expect(text()).toContain(
      "Outlook can open the EML export by drag and drop, or import the MBOX file with common tools.",
    );
  });

  it("does not show MSG while the server cannot write it, and offers it once it can", async () => {
    await mount(snapshotRequest());
    expect(radio("msg_zip")).toBeNull();
    expect(text()).not.toContain("MSG files in a ZIP");
    act(() => root.unmount());
    container.remove();

    fetchExportFormats.mockResolvedValue(
      SHIPPED.map((format) =>
        format.id === "msg_zip" ? { id: "msg_zip", available: true } : format,
      ),
    );
    await mount(snapshotRequest());
    expect(radio("msg_zip")?.disabled).toBe(false);
    expect(text()).toContain("rebuilt from the mail, not from the original bytes");
  });

  it("says that only mail is exported, with the calendar hint for a mailbox only", async () => {
    await mount(snapshotRequest());
    expect(text()).toContain("Only mail is exported. Calendar items and contacts are left out.");
    act(() => root.unmount());
    container.remove();

    await mount(snapshotRequest({ object: { ...object, kind: "imap" } }));
    expect(text()).toContain("Only mail is exported.");
    expect(text()).not.toContain("Calendar items and contacts");
  });

  it("starts an export of the selection and opens the export page", async () => {
    await mount(snapshotRequest());
    await act(async () => {
      radio("mbox")?.click();
      await flush();
    });
    await type(container.querySelector<HTMLInputElement>("#export-file-name"), "Anna July.mbox");
    await submit();

    expect(createExport).toHaveBeenCalledTimes(1);
    expect(createExport).toHaveBeenCalledWith({
      origin: "snapshot",
      snapshotId: "snap-1",
      selection: [{ path: "Mail/Inbox", kind: "folder" }],
      format: "mbox",
      fileName: "Anna July",
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/exports/exp-1" });
    expect(onClose).toHaveBeenCalled();
  });

  it("exports the whole restore point as the root folder", async () => {
    await mount({ origin: "snapshot", object, snapshot, scope: { kind: "everything" } });
    expect(text()).toContain("All mail at this restore point");
    await submit();
    expect(createExport).toHaveBeenCalledWith({
      origin: "snapshot",
      snapshotId: "snap-1",
      selection: [{ path: "", kind: "folder" }],
      format: "eml_zip",
    });
  });

  it("requires a reason for somebody else's mailbox and sends it", async () => {
    await mount(snapshotRequest({ object: { ...object, own: false } }));
    expect(text()).toContain("Export on behalf of the owner");

    await submit();
    expect(createExport).not.toHaveBeenCalled();
    expect(text()).toContain("Enter a reason of at least 3 characters.");

    await type(
      container.querySelector<HTMLTextAreaElement>("#export-reason"),
      "INC-77 legal request",
    );
    await submit();
    expect(createExport).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "snapshot", reason: "INC-77 legal request" }),
    );
  });

  it("does not ask for a reason for one's own mailbox and never sends one", async () => {
    await mount(snapshotRequest());
    expect(container.querySelector("#export-reason")).toBeNull();
    await submit();
    expect(createExport.mock.calls[0]?.[0]).not.toHaveProperty("reason");
  });

  it("exports ticked archive mails by id", async () => {
    await mount({ origin: "archive", scope: { kind: "items", itemIds: ["a1", "a2", "a3"] } });
    expect(text()).toContain("From the archive");
    expect(text()).toContain("3 archived mails selected");
    expect(container.querySelector("#export-reason")).toBeNull();
    await submit();
    expect(createExport).toHaveBeenCalledWith({
      origin: "archive",
      selection: { itemIds: ["a1", "a2", "a3"] },
      format: "eml_zip",
    });
  });

  it("exports the whole current archive search as a filter", async () => {
    await mount({
      origin: "archive",
      scope: { kind: "filter", filter: { q: "invoice", hasAttachment: true }, total: 42 },
    });
    expect(text()).toContain("All mails of the current search (42 results)");
    expect(text()).toContain("Search: “invoice”");
    expect(text()).toContain("Only mails with attachments");
    await submit();
    expect(createExport).toHaveBeenCalledWith({
      origin: "archive",
      selection: { filter: { q: "invoice", hasAttachment: true } },
      format: "eml_zip",
    });
  });

  it("refuses an invalid file name before asking the server", async () => {
    await mount(snapshotRequest());
    await type(container.querySelector<HTMLInputElement>("#export-file-name"), "a/b");
    await submit();
    expect(createExport).not.toHaveBeenCalled();
    expect(text()).toContain("The file name cannot start with a dot");
  });

  it("explains a refusal from the server and stays open", async () => {
    createExport.mockRejectedValue(
      new ApiError(
        422,
        { type: "urn:restow:problem:export-not-mail", title: "Not mail", status: 422 },
        "Not mail",
      ),
    );
    await mount(snapshotRequest());
    await submit();
    expect(text()).toContain("The export could not be started");
    expect(text()).toContain(
      "Only mail can be exported. OneDrive files are not part of an export.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cannot start while the formats are unknown", async () => {
    fetchExportFormats.mockRejectedValue(new ApiError(500, null, "boom"));
    await mount(snapshotRequest());
    expect(text()).toContain("The available formats could not be loaded");
    const submitButton = container.querySelector<HTMLButtonElement>("button[type=submit]");
    expect(submitButton?.disabled).toBe(true);
    await submit();
    expect(createExport).not.toHaveBeenCalled();
  });
});
