// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { TENANT_ID, button, click, mount, text, until } from "../testing/dom";
import { type FakeImportApi, createFakeImportApi, textFile } from "../testing/fake-import-api";
import type { ImportConfig, ImportUploadDto } from "../types";
import { useUploadManager } from "../upload/use-upload-manager";
import { UploadPanel } from "./upload-panel";

vi.mock("@/features/jobs/use-format", () => ({
  useJobFormat: () => ({ duration: (seconds: number) => `${seconds} s` }),
}));

const config: ImportConfig = {
  uploadEnabled: true,
  maxFileBytes: 10 * 1024 * 1024 * 1024,
  segmentSize: 8,
  uploadExpiresHours: 48,
  folder: { enabled: false, path: "/var/lib/restow/import" },
  supportedFormats: ["eml", "msg", "mbox", "zip"],
  refusedFormats: ["pst"],
};

let fake: FakeImportApi;
let unfinishedList: ImportUploadDto[] = [];
let discarded: string[] = [];

/** The panel wired to the real upload manager, like the wizard does it. */
function Harness() {
  const manager = useUploadManager({ tenantId: TENANT_ID, config, unfinished: unfinishedList });
  return (
    <UploadPanel
      manager={manager}
      config={config}
      unfinished={unfinishedList}
      onDiscardUnfinished={(id) => discarded.push(id)}
      discarding={false}
    />
  );
}

async function pick(container: HTMLElement, files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  fake = createFakeImportApi();
  unfinishedList = [];
  discarded = [];
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("UploadPanel", () => {
  it("uploads a picked file and shows it ready with its detected format", async () => {
    const view = mount(<Harness />);
    expect(text(view.container)).toContain("Drop mail files here");
    expect(text(view.container)).toContain("Up to 10 GB per file");

    await pick(view.container, [textFile("inbox.eml", "Subject: hello world\n")]);
    expect(text(view.container)).toContain("inbox.eml");

    await until(() => expect(text(view.container)).toContain("Ready to import"));
    expect(text(view.container)).toContain("EML");
    expect(fake.callsTo(/^PUT /)).toHaveLength(3);
    expect(fake.callsTo(/^POST .*\/complete$/)).toHaveLength(1);
    view.unmount();
  });

  it("shows overall progress for several files", async () => {
    const view = mount(<Harness />);
    await pick(view.container, [
      textFile("a.eml", "Subject: a\n"),
      textFile("b.eml", "Subject: b\n"),
    ]);
    await until(() => expect(text(view.container)).toContain("2 of 2 files"));
    expect(view.container.querySelector('[role="progressbar"]')).not.toBeNull();
    view.unmount();
  });

  it("refuses a PST file with the friendly message and keeps it out of the import", async () => {
    const view = mount(<Harness />);
    await pick(view.container, [textFile("archive.pst", "!BDN0000 binary")]);

    await until(() =>
      expect(text(view.container)).toContain("PST and OST files cannot be imported yet"),
    );
    expect(text(view.container)).toContain("planned for a later release");
    expect(text(view.container)).toContain("Export the mailbox from Outlook as MSG or EML files");
    expect(text(view.container)).toContain("The file is not part of the import.");
    expect(text(view.container)).not.toContain("Ready to import");
    view.unmount();
  });

  it("refuses a file that is not a mail file", async () => {
    const view = mount(<Harness />);
    await pick(view.container, [textFile("photo.jpg", "\u0000\u0001 not mail at all")]);
    await until(() => expect(text(view.container)).toContain("This is not a supported mail file"));
    view.unmount();
  });

  it("names the limit when the server says the file is too large", async () => {
    fake = createFakeImportApi({ maxFileBytes: 4 });
    vi.stubGlobal("fetch", fake.fetch);
    const view = mount(<Harness />);
    await pick(view.container, [textFile("big.eml", "Subject: too big for the server\n")]);
    await until(() => expect(text(view.container)).toContain("larger than the limit of 10 GB"));
    // Trying again cannot help, so no retry button is offered.
    expect(() => button(view.container, "Try again")).toThrow();
    view.unmount();
  });

  it("explains that the staging area is full and offers to try again later", async () => {
    fake.failWith({
      match: /^POST \/imports\/uploads$/,
      respond: 422,
      problemType: "urn:restow:problem:import-staging-full",
    });
    const view = mount(<Harness />);
    await pick(view.container, [textFile("inbox.eml", "Subject: hi\n")]);
    await until(() =>
      expect(text(view.container)).toContain("The space for files that wait for an import is full"),
    );
    expect(text(view.container)).toContain("server import folder");
    // The space may be free later, so trying again is offered.
    expect(() => button(view.container, "Try again")).not.toThrow();
    view.unmount();
  });

  it("offers a retry after a network failure and continues", async () => {
    fake.failWith({ match: /^PUT .*\/segments\/0$/, times: 4, respond: 503 });
    const view = mount(<Harness />);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await pick(view.container, [textFile("inbox.eml", "Subject: hi\n")]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
    } finally {
      vi.useRealTimers();
    }
    await until(() => expect(text(view.container)).toContain("The server could not be reached"));
    await click(button(view.container, "Try again"));
    await until(() => expect(text(view.container)).toContain("Ready to import"));
    view.unmount();
  });

  it("removes a file from the list", async () => {
    const view = mount(<Harness />);
    await pick(view.container, [textFile("inbox.eml", "Subject: hello world\n")]);
    await until(() => expect(text(view.container)).toContain("Ready to import"));
    await click(button(view.container, /Remove inbox\.eml/));
    expect(text(view.container)).not.toContain("inbox.eml");
    await until(() => expect(fake.callsTo(/^DELETE /)).toHaveLength(1));
    view.unmount();
  });

  it("continues an earlier upload when the same file is picked again", async () => {
    const earlier: ImportUploadDto = {
      id: "old",
      fileName: "inbox.eml",
      size: 21,
      segmentSize: 8,
      segmentCount: 3,
      status: "uploading",
      receivedSegments: [0, 1],
      detectedFormat: null,
      refusal: null,
      expiresAt: "2026-10-02T10:00:00.000Z",
    };
    fake = createFakeImportApi({ uploads: [earlier] });
    const stored = fake.uploads.get("old");
    stored?.segments.set(0, new TextEncoder().encode("Subject:"));
    stored?.segments.set(1, new TextEncoder().encode(" hello w"));
    vi.stubGlobal("fetch", fake.fetch);
    unfinishedList = [earlier];

    const view = mount(<Harness />);
    // The earlier upload is listed with the hint how to continue it.
    expect(text(view.container)).toContain("Unfinished uploads");
    expect(text(view.container)).toContain("Add this file again to continue.");

    await pick(view.container, [textFile("inbox.eml", "Subject: hello world\n")]);
    await until(() => expect(text(view.container)).toContain("Ready to import"));
    expect(fake.callsTo(/^POST \/imports\/uploads$/)).toHaveLength(0);
    expect(fake.callsTo(/^PUT /).map((call) => call.path)).toEqual([
      "/imports/uploads/old/segments/2",
    ]);
    expect(text(view.container)).toContain("Continued");
    view.unmount();
  });

  it("uses a finished upload from an earlier visit and discards one on request", async () => {
    const done: ImportUploadDto = {
      id: "done",
      fileName: "archive.mbox",
      size: 4000,
      segmentSize: 1000,
      segmentCount: 4,
      status: "ready",
      receivedSegments: [0, 1, 2, 3],
      detectedFormat: "mbox",
      refusal: null,
      expiresAt: "2026-10-02T10:00:00.000Z",
    };
    unfinishedList = [done];
    const view = mount(<Harness />);
    expect(text(view.container)).toContain("archive.mbox");
    await click(button(view.container, "Discard"));
    expect(discarded).toEqual(["done"]);
    await click(button(view.container, "Use this file"));
    expect(text(view.container)).toContain("Ready to import");
    expect(text(view.container)).toContain("MBOX");
    view.unmount();
  });

  it("skips a dropped folder and adds the dropped files", async () => {
    const view = mount(<Harness />);
    const zone = view.container.querySelector<HTMLElement>("[data-dragging], .border-dashed");
    if (!zone) throw new Error("no drop zone");
    const file = textFile("dropped.eml", "Subject: dropped\n");
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        types: ["Files"],
        items: [
          { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false }) },
          { kind: "file", getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true }) },
        ],
        files: [file],
      },
    });
    await act(async () => {
      zone.dispatchEvent(event);
    });
    await until(() => expect(text(view.container)).toContain("Ready to import"));
    expect(text(view.container)).toContain("dropped.eml");
    view.unmount();
  });
});
