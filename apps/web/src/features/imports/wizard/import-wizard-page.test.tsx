// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { button, click, jsonResponse, mount, text, typeInto, until } from "../testing/dom";
import { type FakeImportApi, createFakeImportApi, textFile } from "../testing/fake-import-api";
import { IMPORT_ID, OBJECT_ID, config } from "../testing/fixtures";
import type { CreateImportInput, FolderListing, ImportConfig } from "../types";
import { ImportWizardPage } from "./import-wizard-page";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigate,
    // No router in these tests: the leave guard has its own test (upload-leave-guard.dom.test.tsx).
    useBlocker: () => ({ status: "idle" }),
    Link: ({
      children,
      className,
      to,
    }: { children: ReactNode; className?: string; to: string }) => (
      <a className={className} href={String(to)}>
        {children}
      </a>
    ),
  };
});

vi.mock("@/features/jobs/use-format", () => ({
  useJobFormat: () => ({ duration: (seconds: number) => `${seconds} s` }),
}));

const folderListing: FolderListing = {
  enabled: true,
  path: "",
  current: "",
  entries: [
    {
      name: "old-mail.mbox",
      path: "old-mail.mbox",
      type: "file",
      size: 4096,
      modifiedAt: "2026-09-20T10:00:00.000Z",
      format: "mbox",
      supported: true,
    },
    {
      name: "outlook.pst",
      path: "outlook.pst",
      type: "file",
      size: 4096,
      modifiedAt: "2026-09-20T10:00:00.000Z",
      format: "pst",
      supported: false,
    },
  ],
};

interface Setup {
  config?: ImportConfig;
  createResponse?: () => Response;
  importedObjects?: unknown[];
}

let fake: FakeImportApi;
let posted: CreateImportInput[];

function stubApi(setup: Setup = {}) {
  fake = createFakeImportApi();
  posted = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const method = (init.method ?? "GET").toUpperCase();
      if (path.startsWith("/imports/uploads")) {
        return fake.fetch(input, init);
      }
      if (path === "/imports/config") return jsonResponse(setup.config ?? config);
      if (path === "/imports/folder") return jsonResponse(folderListing);
      if (path === "/archive/retention")
        return jsonResponse({ mode: "from_capture", years: 8, source: "default" });
      if (path === "/snapshots/objects")
        return jsonResponse({ items: setup.importedObjects ?? [] });
      if (path === "/imports" && method === "GET") return jsonResponse({ items: [] });
      if (path === "/imports" && method === "POST") {
        posted.push(JSON.parse(String(init.body)) as CreateImportInput);
        return (
          setup.createResponse?.() ??
          jsonResponse({ id: IMPORT_ID, jobId: "j1", objectId: OBJECT_ID, sourceId: "s1" }, 202)
        );
      }
      return jsonResponse({ type: "about:blank", title: "not found", status: 404 }, 404);
    }),
  );
}

async function loaded(view: ReturnType<typeof mount>) {
  await until(() => expect(text(view.container)).toContain("Where do the files come from?"));
}

const next = (view: ReturnType<typeof mount>) => click(button(view.container, "Continue"));
const radio = (view: ReturnType<typeof mount>, id: string) =>
  view.container.querySelector(`#${id}`) as HTMLElement;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  navigate.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("step 1: source", () => {
  it("offers both origins and says what can and cannot be imported", async () => {
    stubApi();
    const view = mount(<ImportWizardPage />);
    await loaded(view);
    const content = text(view.container);
    expect(content).toContain("Import mail files");
    expect(content).toContain("Upload from this computer");
    expect(content).toContain("Server import folder");
    expect(content).toContain("MailStore's own archive format cannot be read");
    expect(content).toContain("PST and OST files are planned for a later release");
    expect(content).toContain("Calendar entries and contacts are not");
    expect(content).toContain("MSG messages are rebuilt as EML");
    view.unmount();
  });

  it("explains a missing import folder with the path and how to mount one", async () => {
    stubApi({ config: { ...config, folder: { enabled: false, path: "/data/mail-import" } } });
    const view = mount(<ImportWizardPage />);
    await loaded(view);
    expect(text(view.container)).toContain("The import folder is not available");
    expect(text(view.container)).toContain("No readable folder is mounted at /data/mail-import");
    expect(text(view.container)).toContain("- ./import:/data/mail-import:ro");
    expect(radio(view, "origin-folder").getAttribute("data-disabled")).not.toBeNull();
    view.unmount();
  });

  it("says so when uploads are switched off and starts on the folder", async () => {
    stubApi({ config: { ...config, uploadEnabled: false } });
    const view = mount(<ImportWizardPage />);
    await loaded(view);
    expect(text(view.container)).toContain("Uploads are switched off on this server.");
    expect(radio(view, "origin-upload").getAttribute("data-disabled")).not.toBeNull();
    expect(radio(view, "origin-folder").getAttribute("aria-checked")).toBe("true");
    view.unmount();
  });

  it("does not show the wizard to a plain user", async () => {
    stubApi();
    const { sessionValue } = await import("../testing/dom");
    const view = mount(<ImportWizardPage />, sessionValue("tenant_user"));
    await until(() => expect(text(view.container)).toContain("You do not have permission"));
    expect(text(view.container)).not.toContain("Where do the files come from?");
    view.unmount();
  });
});

describe("folder import from start to POST", () => {
  it("walks the four steps and starts the import", async () => {
    stubApi();
    const view = mount(<ImportWizardPage />);
    await loaded(view);

    await click(radio(view, "origin-folder"));
    await next(view);
    await until(() => expect(text(view.container)).toContain("old-mail.mbox"));

    // Nothing selected: the step says what is missing.
    await next(view);
    expect(text(view.container)).toContain("Add at least one file to import.");

    await click(
      view.container.querySelector('button[aria-label="Select old-mail.mbox"]') as Element,
    );
    expect(text(view.container)).toContain("1 entry");
    // The PST is visible and cannot be selected.
    expect(
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Select outlook.pst"]')
        ?.disabled,
    ).toBe(true);
    await next(view);

    // Target: a name is required.
    expect(text(view.container)).toContain("Where should the messages go?");
    await next(view);
    expect(text(view.container)).toContain("Enter a name.");
    await typeInto(
      view.container.querySelector("#target-name") as HTMLInputElement,
      "x".repeat(121),
    );
    await next(view);
    expect(text(view.container)).toContain("at most 120 characters");
    await typeInto(
      view.container.querySelector("#target-name") as HTMLInputElement,
      "  Old mail  ",
    );
    await click(view.container.querySelector("#target-archive") as Element);
    // Ingesting into the archive cannot be undone; the retention says for how long.
    expect(text(view.container)).toContain("This cannot be undone");
    await until(() =>
      expect(text(view.container)).toContain("Retention in this tenant: 8 years from ingestion."),
    );
    await next(view);

    expect(text(view.container)).toContain("Review and start");
    expect(text(view.container)).toContain("New imported mailbox: Old mail");
    expect(text(view.container)).toContain("Server import folder");
    // Not started yet: the review speaks of what will happen.
    expect(text(view.container)).toContain(
      "Will also be ingested into the archive (cannot be undone)",
    );
    expect(text(view.container)).toContain("old-mail.mbox");

    await click(button(view.container, "Start import"));
    await until(() => expect(navigate).toHaveBeenCalled());
    expect(posted).toEqual([
      { name: "Old mail", files: [{ origin: "folder", path: "old-mail.mbox" }], archive: true },
    ]);
    expect(navigate).toHaveBeenCalledWith({ to: `/imports/${IMPORT_ID}` });
    view.unmount();
  });

  it("goes back to an earlier step through the step list and the back button", async () => {
    stubApi();
    const view = mount(<ImportWizardPage />);
    await loaded(view);
    await click(radio(view, "origin-folder"));
    await next(view);
    expect(text(view.container)).toContain("Choose the files");
    await click(button(view.container, "Back"));
    expect(text(view.container)).toContain("Where do the files come from?");
    view.unmount();
  });

  it("shows the friendly message when the API refuses a PST", async () => {
    stubApi({
      createResponse: () =>
        jsonResponse(
          {
            type: "urn:restow:problem:import-format-not-supported",
            title: "x",
            status: 422,
            code: "pst_not_supported",
          },
          422,
        ),
    });
    const view = mount(<ImportWizardPage />);
    await loaded(view);
    await click(radio(view, "origin-folder"));
    await next(view);
    await until(() => expect(text(view.container)).toContain("old-mail.mbox"));
    await click(
      view.container.querySelector('button[aria-label="Select old-mail.mbox"]') as Element,
    );
    await next(view);
    await typeInto(view.container.querySelector("#target-name") as HTMLInputElement, "Old mail");
    await next(view);
    await click(button(view.container, "Start import"));
    await until(() => expect(text(view.container)).toContain("PST or OST file"));
    expect(navigate).not.toHaveBeenCalled();
    view.unmount();
  });

  it("says that an import into the mailbox is already waiting", async () => {
    stubApi({
      createResponse: () =>
        jsonResponse(
          { type: "urn:restow:problem:import-already-queued", title: "x", status: 409 },
          409,
        ),
    });
    const view = mount(<ImportWizardPage />);
    await loaded(view);
    await click(radio(view, "origin-folder"));
    await next(view);
    await until(() => expect(text(view.container)).toContain("old-mail.mbox"));
    await click(
      view.container.querySelector('button[aria-label="Select old-mail.mbox"]') as Element,
    );
    await next(view);
    await typeInto(view.container.querySelector("#target-name") as HTMLInputElement, "Old mail");
    await next(view);
    await click(button(view.container, "Start import"));
    await until(() =>
      expect(text(view.container)).toContain("An import into this mailbox is already waiting"),
    );
    view.unmount();
  });
});

describe("target step", () => {
  it("cannot add to an existing mailbox when there is none", async () => {
    stubApi();
    const view = mount(<ImportWizardPage />);
    await loaded(view);
    await click(radio(view, "origin-folder"));
    await next(view);
    await until(() => expect(text(view.container)).toContain("old-mail.mbox"));
    await click(
      view.container.querySelector('button[aria-label="Select old-mail.mbox"]') as Element,
    );
    await next(view);
    await until(() => expect(text(view.container)).toContain("There is no imported mailbox yet."));
    expect(radio(view, "target-existing").getAttribute("data-disabled")).not.toBeNull();
    view.unmount();
  });

  it("offers the imported mailboxes the account list knows", async () => {
    stubApi({
      importedObjects: [
        {
          id: OBJECT_ID,
          displayName: "Mail archive 2019",
          externalId: "import-1",
          sourceKind: "import",
        },
        { id: "other", displayName: "Anna", externalId: "ext", sourceKind: "m365" },
      ],
    });
    const view = mount(<ImportWizardPage />);
    await loaded(view);
    await click(radio(view, "origin-folder"));
    await next(view);
    await until(() => expect(text(view.container)).toContain("old-mail.mbox"));
    await click(
      view.container.querySelector('button[aria-label="Select old-mail.mbox"]') as Element,
    );
    await next(view);
    await until(() =>
      expect(radio(view, "target-existing").getAttribute("data-disabled")).toBeNull(),
    );
    await click(radio(view, "target-existing"));
    expect(text(view.container)).toContain("Imported mailbox");
    view.unmount();
  });
});

describe("upload import through the wizard", () => {
  it("uploads a file, waits for it, and sends its upload id", async () => {
    stubApi();
    const view = mount(<ImportWizardPage />);
    await loaded(view);
    await next(view);

    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input, "files", {
      value: [textFile("inbox.eml", "Subject: hello world\n")],
      configurable: true,
    });
    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => expect(text(view.container)).toContain("Ready to import"));

    await next(view);
    await typeInto(
      view.container.querySelector("#target-name") as HTMLInputElement,
      "Upload mailbox",
    );
    await next(view);
    expect(text(view.container)).toContain("1 file, 21 byte");
    await click(button(view.container, "Start import"));
    await until(() => expect(navigate).toHaveBeenCalled());
    expect(posted).toEqual([
      { name: "Upload mailbox", files: [{ origin: "upload", uploadId: "u1" }], archive: false },
    ]);
    view.unmount();
  });

  it("ignores a refused PST upload when starting", async () => {
    stubApi();
    const view = mount(<ImportWizardPage />);
    await loaded(view);
    await next(view);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input, "files", {
      value: [
        textFile("outlook.pst", "!BDN0000 binary"),
        textFile("inbox.eml", "Subject: hello world\n"),
      ],
      configurable: true,
    });
    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => {
      expect(text(view.container)).toContain("PST and OST files cannot be imported yet");
      expect(text(view.container)).toContain("Ready to import");
    });
    await next(view);
    await typeInto(view.container.querySelector("#target-name") as HTMLInputElement, "Mixed");
    await next(view);
    await click(button(view.container, "Start import"));
    await until(() => expect(posted).toHaveLength(1));
    // Only the accepted file is part of the request.
    expect(posted[0]?.files).toHaveLength(1);
    expect(posted[0]?.files[0]).toMatchObject({ origin: "upload" });
    view.unmount();
  });

  it("blocks starting while an upload is still running", async () => {
    stubApi();
    // Segments crawl so the upload is still busy on the review step.
    fake.failWith({ match: /^PUT /, times: 1000, respond: "network" });
    const view = mount(<ImportWizardPage />);
    await loaded(view);
    await next(view);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input, "files", {
      value: [textFile("inbox.eml", "Subject: hello world\n")],
      configurable: true,
    });
    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await next(view);
    await typeInto(view.container.querySelector("#target-name") as HTMLInputElement, "Slow");
    await next(view);
    expect(text(view.container)).toContain("still uploading");
    await click(button(view.container, "Start import"));
    expect(text(view.container)).toContain("Wait until all uploads have finished.");
    expect(posted).toHaveLength(0);
    view.unmount();
  });
});
