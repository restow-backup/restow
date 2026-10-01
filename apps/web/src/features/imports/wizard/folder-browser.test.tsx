// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { button, click, jsonResponse, mount, text, until } from "../testing/dom";
import type { FolderEntry, FolderListing } from "../types";
import { FolderBrowser, SelectedEntries, sortEntries, unsupportedReason } from "./folder-browser";
import type { FolderSelection } from "./wizard-state";

const entry = (
  overrides: Partial<FolderEntry> & Pick<FolderEntry, "name" | "path">,
): FolderEntry => ({
  type: "file",
  size: 2048,
  modifiedAt: "2026-09-20T10:00:00.000Z",
  format: "eml",
  supported: true,
  ...overrides,
});

const root: FolderListing = {
  enabled: true,
  path: "",
  current: "",
  entries: [
    entry({ name: "zeta.eml", path: "zeta.eml" }),
    entry({ name: "Mail 2019", path: "Mail 2019", type: "directory", size: null, format: null }),
    entry({
      name: "outlook.pst",
      path: "outlook.pst",
      format: "pst",
      supported: false,
      size: 5_000_000,
    }),
    entry({ name: "photo.jpg", path: "photo.jpg", format: "unknown", supported: false }),
    entry({ name: "alpha.mbox", path: "alpha.mbox", format: "mbox" }),
  ],
};

const nested: FolderListing = {
  enabled: true,
  path: "Mail 2019",
  current: "Mail 2019",
  entries: [entry({ name: "inbox.eml", path: "Mail 2019/inbox.eml" })],
};

function stubListing(listings: Record<string, FolderListing | number>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.searchParams.get("path") ?? "";
    const listing = listings[path];
    if (typeof listing === "number") {
      return jsonResponse({ type: "about:blank", title: "x", status: listing }, listing);
    }
    return jsonResponse(listing ?? root);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("folder helpers", () => {
  it("puts folders first and sorts names naturally", () => {
    const sorted = sortEntries([
      entry({ name: "b10.eml", path: "b10.eml" }),
      entry({ name: "dir", path: "dir", type: "directory" }),
      entry({ name: "b2.eml", path: "b2.eml" }),
    ]);
    expect(sorted.map((item) => item.name)).toEqual(["dir", "b2.eml", "b10.eml"]);
  });

  it("says why an entry cannot be selected", () => {
    expect(
      unsupportedReason(entry({ name: "a.pst", path: "a.pst", format: "pst", supported: false })),
    ).toBe("pst");
    expect(
      unsupportedReason(
        entry({ name: "a.jpg", path: "a.jpg", format: "unknown", supported: false }),
      ),
    ).toBe("unknown");
    expect(
      unsupportedReason(entry({ name: "a.x", path: "a.x", format: "eml", supported: false })),
    ).toBe("other");
    expect(
      unsupportedReason(entry({ name: "d", path: "d", type: "directory", supported: false })),
    ).toBeNull();
    expect(unsupportedReason(entry({ name: "a.eml", path: "a.eml" }))).toBeNull();
  });
});

describe("FolderBrowser", () => {
  it("lists folders first with format badges, and disables what cannot be imported", async () => {
    stubListing({ "": root });
    const onToggle = vi.fn();
    const view = mount(
      <FolderBrowser path="" onPathChange={() => {}} selection={[]} onToggle={onToggle} />,
    );
    await until(() => expect(text(view.container)).toContain("alpha.mbox"));

    const rows = [...view.container.querySelectorAll("tbody tr")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows[0]).toContain("Mail 2019");
    expect(rows[1]).toContain("alpha.mbox");
    expect(rows[1]).toContain("MBOX");

    // Unsupported entries stay visible with their reason.
    const pst = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Select outlook.pst"]',
    );
    expect(pst?.disabled).toBe(true);
    expect(text(view.container)).toContain("PST and OST files are planned for a later release.");
    expect(
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Select photo.jpg"]')
        ?.disabled,
    ).toBe(true);
    expect(text(view.container)).toContain("Not recognized as a mail file.");

    await click(view.container.querySelector('button[aria-label="Select alpha.mbox"]') as Element);
    expect(onToggle).toHaveBeenCalledWith({
      path: "alpha.mbox",
      name: "alpha.mbox",
      type: "file",
      size: 2048,
      format: "mbox",
    });
    await click(view.container.querySelector('button[aria-label="Select Mail 2019"]') as Element);
    expect(onToggle).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "Mail 2019", type: "directory" }),
    );
    view.unmount();
  });

  it("opens a folder by its name and shows the breadcrumb", async () => {
    stubListing({ "": root, "Mail 2019": nested });
    const onPathChange = vi.fn();
    const view = mount(
      <FolderBrowser path="" onPathChange={onPathChange} selection={[]} onToggle={() => {}} />,
    );
    await until(() => expect(text(view.container)).toContain("Mail 2019"));
    await click(button(view.container, "Mail 2019"));
    expect(onPathChange).toHaveBeenCalledWith("Mail 2019");
    view.unmount();

    const inside = mount(
      <FolderBrowser
        path="Mail 2019"
        onPathChange={onPathChange}
        selection={[]}
        onToggle={() => {}}
      />,
    );
    await until(() => expect(text(inside.container)).toContain("inbox.eml"));
    const crumbs = inside.container.querySelector("nav");
    expect(crumbs?.textContent).toContain("Import folder");
    expect(crumbs?.textContent).toContain("Mail 2019");
    await click(button(inside.container, "Import folder"));
    expect(onPathChange).toHaveBeenLastCalledWith("");
    inside.unmount();
  });

  it("shows entries inside a selected folder as included and not selectable on their own", async () => {
    stubListing({ "Mail 2019": nested });
    const selection: FolderSelection[] = [
      { path: "Mail 2019", name: "Mail 2019", type: "directory", size: null, format: null },
    ];
    const view = mount(
      <FolderBrowser
        path="Mail 2019"
        onPathChange={() => {}}
        selection={selection}
        onToggle={() => {}}
      />,
    );
    await until(() => expect(text(view.container)).toContain("inbox.eml"));
    expect(text(view.container)).toContain("Included through the selected folder Mail 2019");
    const box = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Select inbox.eml"]',
    );
    expect(box?.disabled).toBe(true);
    expect(box?.getAttribute("aria-checked")).toBe("true");
    view.unmount();
  });

  it("tells that the folder is empty", async () => {
    stubListing({ "": { ...root, entries: [] } });
    const view = mount(
      <FolderBrowser path="" onPathChange={() => {}} selection={[]} onToggle={() => {}} />,
    );
    await until(() => expect(text(view.container)).toContain("This folder is empty."));
    view.unmount();
  });

  it("offers the way back when the folder no longer exists", async () => {
    stubListing({ gone: 404 });
    const onPathChange = vi.fn();
    const view = mount(
      <FolderBrowser path="gone" onPathChange={onPathChange} selection={[]} onToggle={() => {}} />,
    );
    await until(() => expect(text(view.container)).toContain("This folder no longer exists"));
    await click(button(view.container, "Back to the import folder"));
    expect(onPathChange).toHaveBeenCalledWith("");
    view.unmount();
  });

  it("shows an error with a retry when the listing fails", async () => {
    stubListing({ "": 500 });
    const view = mount(
      <FolderBrowser path="" onPathChange={() => {}} selection={[]} onToggle={() => {}} />,
    );
    await until(() =>
      expect(text(view.container)).toContain("The import folder could not be read"),
    );
    expect(() => button(view.container, "Retry")).not.toThrow();
    view.unmount();
  });
});

describe("SelectedEntries", () => {
  const selection: FolderSelection[] = [
    { path: "Mail 2019", name: "Mail 2019", type: "directory", size: null, format: null },
    { path: "zeta.eml", name: "zeta.eml", type: "file", size: 2048, format: "eml" },
  ];

  it("lists what is selected and takes single entries out again", async () => {
    const onRemove = vi.fn();
    const onClear = vi.fn();
    const view = mount(
      <SelectedEntries selection={selection} onRemove={onRemove} onClear={onClear} />,
    );
    expect(text(view.container)).toContain("2 entries");
    expect(text(view.container)).toContain("Mail 2019");
    await click(button(view.container, /Remove zeta\.eml/));
    expect(onRemove).toHaveBeenCalledWith("zeta.eml");
    await click(button(view.container, "Clear"));
    expect(onClear).toHaveBeenCalled();
    view.unmount();
  });

  it("says when nothing is selected", () => {
    const view = mount(<SelectedEntries selection={[]} onRemove={() => {}} onClear={() => {}} />);
    expect(text(view.container)).toContain("Nothing selected yet.");
    view.unmount();
  });
});
