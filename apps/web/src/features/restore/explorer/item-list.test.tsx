// @vitest-environment happy-dom
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import type { TreeEntry } from "../api.js";
import { EMPTY_SELECTION } from "../lib/selection.js";
import { ItemList } from "./item-list.js";

// `page-context.test.tsx` explains why this is needed: React only flushes
// effects synchronously inside `act` when it knows a test renderer is driving
// it, and nothing else in this workspace sets the flag.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const folder: TreeEntry = {
  id: "e1",
  kind: "folder",
  name: "Projects",
  path: "Inbox/Projects",
  parentPath: "Inbox",
  size: 0,
  mtime: null,
  itemId: null,
  deleted: false,
  implicit: false,
  mail: null,
  contentType: null,
};

const protectedMail: TreeEntry = {
  id: "e2",
  kind: "mail",
  name: "secret.eml",
  path: "Inbox/secret.eml",
  parentPath: "Inbox",
  size: 2048,
  mtime: "2026-09-20T10:00:00.000Z",
  itemId: "item-2",
  deleted: false,
  implicit: false,
  contentType: "message/rfc822",
  mail: {
    subject: "Contract",
    from: "legal@example.com",
    to: "anna@example.com",
    cc: null,
    toCount: 1,
    ccCount: 0,
    date: "2026-09-20T10:00:00.000Z",
    sentDateTime: "2026-09-20T09:58:00.000Z",
    hasAttachments: true,
    isRead: false,
    flagged: false,
    protection: "rights-protected",
  },
};

const manyRecipientsMail: TreeEntry = {
  id: "e3",
  kind: "mail",
  name: "newsletter.eml",
  path: "Inbox/newsletter.eml",
  parentPath: "Inbox",
  size: 4096,
  mtime: "2026-09-21T08:00:00.000Z",
  itemId: "item-3",
  deleted: false,
  implicit: false,
  contentType: "message/rfc822",
  mail: {
    subject: "Weekly digest",
    from: "digest@example.com",
    to: "anna@example.com, bob@example.com",
    cc: null,
    toCount: 5,
    ccCount: 0,
    date: "2026-09-21T08:00:00.000Z",
    sentDateTime: null,
    hasAttachments: false,
    isRead: true,
    flagged: false,
    protection: null,
  },
};

const entries = [folder, protectedMail];

describe("ItemList", () => {
  it("shows Subject, From, To, Date and Size as columns for a mailbox", () => {
    const html = render(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain(">Subject<");
    expect(html).toContain(">From<");
    expect(html).toContain(">To<");
    expect(html).toContain(">Date<");
    expect(html).toContain(">Size<");
    expect(html).toContain("legal@example.com");
    expect(html).toContain("anna@example.com");
  });

  it("shows a lock icon for a rights-protected or encrypted mail", () => {
    const html = render(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Rights-protected or encrypted"');
  });

  it("shows the paperclip for attachments and bolds an unread subject", () => {
    const html = render(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Has attachments"');
    expect(html).toMatch(/font-semibold[^"]*">Contract</);
  });

  it("wires the active row and the grid for Up/Down navigation", () => {
    const html = render(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath="Inbox/secret.eml"
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={() => {}}
      />,
    );
    // `role="grid"` (not a listbox wrapped around a table): every `<tr>`/
    // `<td>` then keeps its ordinary implicit "row"/"gridcell" role instead
    // of a mismatched listbox-div > table > option-row nesting.
    expect(html).toContain('role="grid"');
    expect(html).not.toContain('role="option"');
    expect(html).not.toContain('role="listbox"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(
      `aria-activedescendant="restore-item-${encodeURIComponent("Inbox/secret.eml")}"`,
    );
    expect(html).toContain('aria-selected="true"');
  });

  it("gives the Date cell an overflow-safe class so a long localised date never overlaps From", () => {
    const html = render(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={() => {}}
      />,
    );
    // The Date cell (the one with the `date` column width and the `@lg`
    // breakpoint) must carry `truncate` (overflow-hidden + ellipsis), not
    // just `whitespace-nowrap`, so a date too long for the column clips
    // instead of overlapping the From column next to it.
    expect(html).toMatch(/class="[^"]*\bw-48\b[^"]*\btruncate\b[^"]*@lg:table-cell[^"]*"/);
  });

  it("gives the Date column room for a two-digit hour, in the header and in the cells alike", () => {
    // With `table-fixed` the header decides the width of the column. w-44 left
    // 160px of content, less than "Sep 24, 2026, 10:23 PM" needs, so the end
    // of the time was cut off; the header and every cell now say w-48.
    const html = render(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).toMatch(/<th[^>]*class="[^"]*\bw-48\b[^"]*@lg:table-cell[^"]*"[^>]*>Date</);
    expect(html).not.toMatch(/\bw-44\b[^"]*@lg:table-cell/);
  });

  it("keeps the full date in the tooltip of the Date cell", () => {
    const html = render(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={() => {}}
      />,
    );
    // The title carries the same text as the cell, however it is clipped.
    const cell = html.match(/<td[^>]*@lg:table-cell[^>]*title="([^"]+)"[^>]*>([^<]+)</);
    expect(cell).not.toBeNull();
    expect(cell?.[1]).toBe(cell?.[2]);
  });

  it("renders the To column's '+N more' hint outside the truncating address span so it is never clipped", () => {
    const html = render(
      <ItemList
        entries={[manyRecipientsMail]}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={() => {}}
      />,
    );
    // Two distinct elements: a truncating span around the addresses, and a
    // separate, non-truncating span for "+N more" right after it.
    expect(html).toMatch(
      /<span class="min-w-0 flex-1 truncate">anna@example\.com, bob@example\.com<\/span><span class="shrink-0">\+3 more<\/span>/,
    );
  });

  it("shows From and Date as a compact second line under the subject, for the panes too narrow for those columns", () => {
    const html = render(
      <ItemList
        entries={[protectedMail]}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={() => {}}
      />,
    );
    // Visible below `@xl` (where the real From column is still hidden);
    // the date half additionally hides again at `@lg`, once the real Date
    // column takes over — so nothing is ever duplicated once a pane widens.
    expect(html).toMatch(/class="mt-0\.5 flex min-w-0 items-center gap-1[^"]*@xl:hidden"/);
    expect(html).toContain("legal@example.com");
    // The compact line's own date text sits in a span with `@lg:hidden`.
    expect(html).toMatch(/class="shrink-0 tabular-nums @lg:hidden"/);
  });

  it("never shows the compact second line for a folder row", () => {
    const html = render(
      <ItemList
        entries={[folder]}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).not.toMatch(/@xl:hidden/);
  });

  it("takes the per-row checkbox and name button out of the tab order", () => {
    // The grid is a single-tab-stop composite widget (aria-activedescendant):
    // Tab must skip straight over every row to the next control after the
    // grid, never stopping on a row's own checkbox or name button.
    const html = render(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={() => {}}
      />,
    );
    // The header's select-all checkbox is a real, independent tab stop
    // (outside the grid's own roving-tabindex rows), so only <tbody>'s own
    // controls are asserted here: the name `<button>` and the selection
    // `Checkbox`'s own root element (not the hidden native `<input>` Radix
    // renders alongside it for form submission, which already carries its
    // own fixed `tabIndex={-1}` regardless of this fix).
    const body = html.slice(html.indexOf("<tbody"));
    // Two `<button>`s per row (the Checkbox's Radix root renders as a native
    // `<button role="checkbox">`, next to the name button) — none covered by
    // an ancestor folder in this fixture, so every row has both.
    const buttonTags = body.match(/<button\b[^>]*>/g) ?? [];
    expect(buttonTags.length).toBe(entries.length * 2);
    for (const tag of buttonTags) {
      expect(tag).toContain('tabindex="-1"');
    }
  });

  it("keeps the 'Name' column and grid label for OneDrive", () => {
    const html = render(
      <ItemList
        entries={[folder]}
        objectKind="onedrive"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain(">Name<");
    expect(html).toContain('aria-label="Name"');
  });
});

describe("ItemList keyboard navigation (DOM)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onOpen = vi.fn();

  // happy-dom does not implement `scrollIntoView`; a real browser always
  // does, so stubbing it here only fills in what the test DOM is missing.
  (HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView = vi.fn();

  function mount(node: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
    });
  }

  function pressArrow(direction: "ArrowDown" | "ArrowUp") {
    pressKey(direction);
  }

  function pressKey(key: string) {
    const grid = container.querySelector('[role="grid"]');
    if (!grid) {
      throw new Error("expected a grid");
    }
    act(() => {
      grid.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    onOpen.mockClear();
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
  });

  it("skips folder rows: ArrowDown from nothing active opens the first mail, not the folder above it", () => {
    mount(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={onOpen}
      />,
    );
    pressArrow("ArrowDown");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(protectedMail);
  });

  it("scrolls the active row into view when the active path changes", () => {
    mount(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={protectedMail.path}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={onOpen}
      />,
    );
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("calls onNavigate, not onOpen, for a keyboard move (the caller replaces history instead of pushing)", () => {
    const onNavigate = vi.fn();
    mount(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={onOpen}
        onNavigate={onNavigate}
      />,
    );
    pressArrow("ArrowDown");
    expect(onNavigate).toHaveBeenCalledWith(protectedMail);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("toggles the active row's selection on Space, without a mouse", () => {
    const onToggle = vi.fn();
    mount(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={protectedMail.path}
        onToggle={onToggle}
        onToggleAll={() => {}}
        onOpen={onOpen}
      />,
    );
    pressKey(" ");
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(protectedMail);
  });

  it("does nothing on Space when no row is active", () => {
    const onToggle = vi.fn();
    mount(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={null}
        onToggle={onToggle}
        onToggleAll={() => {}}
        onOpen={onOpen}
      />,
    );
    pressKey(" ");
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("opens the active row on Enter, without a mouse — including a folder", () => {
    mount(
      <ItemList
        entries={entries}
        objectKind="mailbox"
        selection={EMPTY_SELECTION}
        activePath={folder.path}
        onToggle={() => {}}
        onToggleAll={() => {}}
        onOpen={onOpen}
      />,
    );
    pressKey("Enter");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(folder);
  });
});
