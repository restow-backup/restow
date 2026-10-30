// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ReadOnlyGroup } from "@/components/kit/read-only-group";
import { SectionAsideProvider } from "@/components/layout/section-aside";
import { toast } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";

import { directoryKeys } from "./api";
import "./i18n";
import { ObjectsPanel } from "./objects-panel";
import { type DirectorySearch, toObjectsQuery } from "./search";
import type { DirectorySource, ObjectsPage, ProtectedObject } from "./types";

/**
 * The context menu of a protected object's row: the same entries as its "…" menu (where the
 * object leads, a new job with it, the protection decisions), and a new job with every checked
 * object when the row is one of several checked ones.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      children,
      ...props
    }: {
      to: string;
      search?: Record<string, unknown>;
      children: React.ReactNode;
    }) => {
      const query = search ? new URLSearchParams(search as Record<string, string>).toString() : "";
      return (
        <a href={query ? `${to}?${query}` : String(to)} {...props}>
          {children}
        </a>
      );
    },
  };
});

function object(overrides: Partial<ProtectedObject> = {}): ProtectedObject {
  return {
    id: "o-1",
    sourceId: "s-1",
    sourceName: "Contoso",
    sourceKind: "m365",
    kind: "mailbox",
    origin: "directory_sync",
    status: "active",
    externalId: "user-1",
    displayName: "Alice Example",
    userId: "u-1",
    email: "alice@contoso.example",
    upn: "alice@contoso.example",
    sharedOrBlocked: false,
    override: null,
    notSelected: false,
    lastBackupAt: "2026-09-30T02:00:00.000Z",
    snapshotCount: 3,
    legalHold: false,
    latestBackupJob: null,
    readiness: null,
    credential: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const SOURCE: DirectorySource = {
  id: "s-1",
  name: "Contoso",
  kind: "m365",
  status: "active",
  errorMessage: null,
  failure: null,
  lastSyncAt: null,
  consentGranted: true,
  rules: null,
  overrideCount: 0,
  sync: { lastRun: null, lastFullSyncAt: null, fullSyncPending: false, pendingJob: null },
  imapAuthMode: null,
  counts: { total: 2, active: 2, excluded: 0, orphaned: 0, mailbox: 1, onedrive: 1, imap: 0 },
};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface MountOptions {
  /** Wraps the panel, e.g. in the tenant page's section aside or a read-only group. */
  wrap?: (panel: React.ReactNode) => React.ReactNode;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Mounts as the public demo. */
  demo?: boolean;
}

async function mount(
  page: ObjectsPage,
  sources: DirectorySource[] = [SOURCE],
  search: DirectorySearch = {},
  onSearchChange: (change: Partial<DirectorySearch>) => void = () => {},
  options: MountOptions = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(directoryKeys.objectsPage("t-1", toObjectsQuery(search)), page);
  client.setQueryData(["setup", "state"], {
    configured: true,
    demo: { enabled: options.demo === true, email: null, password: null },
  });
  vi.stubGlobal("fetch", options.fetch ?? (async () => new Response("{}", { status: 404 })));
  const wrap = options.wrap ?? ((panel: React.ReactNode) => panel);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <TooltipProvider delayDuration={200}>
            {wrap(
              <ObjectsPanel
                search={search}
                onSearchChange={onSearchChange}
                sources={sources}
                onShowSources={() => {}}
              />,
            )}
          </TooltipProvider>
        </I18nextProvider>
      </QueryClientProvider>,
    );
  });
}

const row = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("tbody tr")].find((candidate) =>
    candidate.textContent?.includes(name),
  ) as HTMLElement;
const menu = () => document.querySelector<HTMLElement>('[data-slot="row-context-menu"]');
const entry = (id: string) => menu()?.querySelector<HTMLElement>(`[data-action="${id}"]`);

async function rightClick(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
    );
  });
}

const PAGE: ObjectsPage = {
  items: [
    object(),
    object({
      id: "o-2",
      kind: "onedrive",
      displayName: "Bob OneDrive",
      externalId: "drive-2",
      snapshotCount: 0,
    }),
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

describe("the backup column", () => {
  it("shows a warning that leads to its reasons, and an acknowledged one quietly", async () => {
    await mount({
      ...PAGE,
      items: [
        object({
          warning: {
            state: "open",
            runId: "r-1",
            failedItems: 2,
            causes: [{ code: "graph.item_too_large", count: 2 }],
            newCauses: ["graph.item_too_large"],
            acknowledgement: null,
          },
        }),
        object({
          id: "o-2",
          displayName: "Bob Example",
          warning: {
            state: "acknowledged",
            runId: "r-2",
            failedItems: 1,
            causes: [{ code: "graph.item_unreadable", count: 1 }],
            newCauses: [],
            acknowledgement: {
              acknowledgedAt: "2026-09-30T03:00:00.000Z",
              acknowledgedBy: "admin@contoso.example",
              note: null,
              causes: ["graph.item_unreadable"],
              runId: "r-2",
              superseded: false,
            },
          },
        }),
      ],
    });
    const open = row("Alice Example").querySelector('[data-warning="open"]');
    expect(open?.textContent).toContain("With warnings");
    expect(open?.querySelector("button")?.textContent).toBe("See the reasons");
    const acknowledged = row("Bob Example").querySelector('[data-warning="acknowledged"]');
    expect(acknowledged?.textContent).toContain("Warning acknowledged");
  });
});

describe("the context menu of an object", () => {
  it("leads to the explorer, starts a job and decides protection", async () => {
    await mount(PAGE);
    expect(
      row("Alice Example").querySelector('[aria-label="Actions for Alice Example"]'),
    ).not.toBeNull();
    await rightClick(row("Alice Example").querySelectorAll("td")[2] as HTMLElement);
    // Mailboxes are restored in the explorer only, never on the machines' file restore page.
    expect(entry("restorePoints")).toBeNull();
    expect(entry("explorer")?.getAttribute("href")).toBe("/restore?object=o-1");
    expect(entry("newJob")?.getAttribute("href")).toBe("/jobs?type=mail&new=1&select=o-1");
    expect(entry("exclude")).not.toBeNull();
  });

  it("closes the restore entries of an object without a backup, and says why", async () => {
    await mount(PAGE);
    await rightClick(row("Bob OneDrive").querySelectorAll("td")[2] as HTMLElement);
    const explorer = entry("explorer");
    expect(explorer?.hasAttribute("data-disabled")).toBe(true);
    expect(explorer?.textContent).toContain("There is no backup of this object yet.");
  });

  it("offers a new job with every checked object on a checked row", async () => {
    await mount(PAGE);
    for (const name of ["Alice Example", "Bob OneDrive"]) {
      await act(async () => {
        row(name).querySelector<HTMLElement>('[role="checkbox"]')?.click();
      });
    }
    await rightClick(row("Bob OneDrive").querySelectorAll("td")[2] as HTMLElement);
    expect(menu()?.getAttribute("aria-label")).toBe("Actions for 2 selected objects");
    expect(entry("newJobFromSelection")?.getAttribute("href")).toBe(
      "/jobs?type=mail&new=1&select=o-1%2Co-2",
    );
  });
});

describe("objects no longer backed up", () => {
  it("reads amber with reason and date, grey with who confirmed it, and leads to the ones waiting", async () => {
    await mount(
      {
        ...PAGE,
        items: [
          object({
            status: "orphaned",
            kind: "onedrive",
            displayName: "Departed OneDrive",
            statusReason: "locked",
            lockHint: "no_license",
            inactiveState: "to_confirm",
            inactiveSince: "2026-10-28T03:00:00.000Z",
            statusConfirmedAt: null,
            statusConfirmedBy: null,
          }),
          object({
            id: "o-2",
            status: "orphaned",
            displayName: "Gone Mailbox",
            inactiveState: "confirmed",
            inactiveSince: "2026-10-01T03:00:00.000Z",
            statusConfirmedAt: "2026-10-02T09:00:00.000Z",
            statusConfirmedBy: "lead@contoso.example",
          }),
        ],
      },
      [{ ...SOURCE, counts: { ...SOURCE.counts, orphaned: 2, toConfirm: 1 } }],
    );
    const waiting = row("Departed OneDrive");
    expect(waiting.textContent).toContain("Not backed up any more, please confirm");
    expect(waiting.textContent).toContain("Locked by Microsoft, since");
    expect(waiting.textContent).toContain("The account has no licence");
    const confirmed = row("Gone Mailbox");
    expect(confirmed.textContent).toContain("Intentionally no longer backed up");
    expect(confirmed.textContent).toContain("Confirmed by lead@contoso.example on");
    expect(document.querySelector('[data-testid="inactive-to-confirm"]')?.textContent).toContain(
      "1 object is no longer backed up and waits for your confirmation.",
    );

    await rightClick(waiting);
    expect(entry("confirmInactive")?.textContent).toContain("Yes, intended");
  });

  it("jumps from the tenant-wide banner to every waiting object, whatever was filtered", async () => {
    const changes: Partial<DirectorySearch>[] = [];
    await mount(
      { items: [object({ displayName: "Filtered Mailbox" })], total: 1, page: 1, pageSize: 25 },
      [{ ...SOURCE, counts: { ...SOURCE.counts, orphaned: 3, toConfirm: 3 } }],
      { kind: "mailbox", source: SOURCE.id, q: "filtered", shared: false, page: 2 },
      (change) => changes.push(change),
    );
    const banner = document.querySelector('[data-testid="inactive-to-confirm"]');
    const show = banner?.querySelector("button");
    expect(show).toBeTruthy();
    await act(async () => {
      show?.click();
    });
    expect(changes.at(-1)).toEqual({
      status: "to_confirm",
      q: undefined,
      kind: undefined,
      source: undefined,
      job: undefined,
      shared: undefined,
      page: 1,
    });
  });
});

const panel = () => document.querySelector<HTMLElement>('[data-slot="selection-panel"]');
const announcement = () =>
  document.querySelector<HTMLElement>('[data-slot="selection-status"]')?.textContent;
const checkbox = (name: string) =>
  row(name).querySelector<HTMLElement>("[data-select-row]") as HTMLElement;
const action = (id: string) => panel()?.querySelector<HTMLElement>(`[data-action="${id}"]`) ?? null;

async function check(name: string) {
  await act(async () => {
    checkbox(name).click();
  });
}

async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/** Lets the timers of a focus return (and Radix's own) run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function wide(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

describe("the selection panel", () => {
  it("appears with the first checked object after the list, says how many, and goes with the last", async () => {
    wide(false);
    await mount(PAGE);
    expect(panel()).toBeNull();
    expect(announcement()).toBe("");

    await check("Alice Example");
    const shown = panel();
    expect(shown?.dataset.variant).toBe("bar");
    expect(shown?.getAttribute("role")).toBe("region");
    expect(shown?.getAttribute("aria-label")).toBe("Actions for the selection");
    expect(shown?.querySelector('[data-slot="selection-count"]')?.textContent).toContain(
      "1 selected",
    );
    expect(announcement()).toBe("1 selected");
    // Out of the list's flow: nothing above the rows moved, the bar follows the table.
    const table = document.querySelector("table") as HTMLElement;
    expect(
      table.compareDocumentPosition(shown as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    for (const id of ["include", "exclude", "moreSelectionActions", "clearSelection"]) {
      expect(action(id), id).not.toBeNull();
    }

    await check("Bob OneDrive");
    expect(announcement()).toBe("2 selected");
    await check("Alice Example");
    await check("Bob OneDrive");
    expect(panel()).toBeNull();
    expect(announcement()).toBe("Selection cleared");
  });

  it("keeps the checkbox, and its focus, when a row is checked: the cells are not rebuilt", async () => {
    wide(false);
    await mount(PAGE);
    const box = checkbox("Alice Example");
    const name = row("Bob OneDrive").querySelector('[data-column="name"]')?.firstElementChild;
    expect(box.getAttribute("aria-label")).toBe("Select Alice Example");
    box.focus();
    await check("Alice Example");
    expect(checkbox("Alice Example")).toBe(box);
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(box);
    expect(row("Bob OneDrive").querySelector('[data-column="name"]')?.firstElementChild).toBe(name);
  });

  it("clears the selection on Escape in the panel or in the list, and returns focus to the row last checked", async () => {
    wide(false);
    await mount(PAGE);
    await check("Alice Example");
    await check("Bob OneDrive");
    const include = action("include") as HTMLElement;
    include.focus();
    await press(include, "Escape");
    expect(panel()).toBeNull();
    await settle();
    expect(document.activeElement).toBe(checkbox("Bob OneDrive"));

    await check("Alice Example");
    expect(panel()).not.toBeNull();
    await press(checkbox("Alice Example"), "Escape");
    expect(panel()).toBeNull();
  });

  it("clears the selection with its own button", async () => {
    wide(false);
    await mount(PAGE);
    await check("Alice Example");
    await act(async () => {
      action("clearSelection")?.click();
    });
    expect(panel()).toBeNull();
    expect(checkbox("Alice Example").getAttribute("aria-checked")).toBe("false");
    await settle();
    expect(document.activeElement).toBe(checkbox("Alice Example"));
  });

  it("keeps the selection when Escape closes a confirmation opened from it", async () => {
    wide(false);
    await mount(PAGE);
    await check("Alice Example");
    await act(async () => {
      action("exclude")?.click();
    });
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Exclude 1 object from backup?");
    await press(dialog as HTMLElement, "Escape");
    await settle();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(panel()).not.toBeNull();
    expect(announcement()).toBe("1 selected");
  });

  it("applies a confirmed decision to every checked object and clears the selection", async () => {
    wide(false);
    const calls: { url: string; body: unknown }[] = [];
    await mount(PAGE, [SOURCE], {}, () => {}, {
      fetch: async (url, init) => {
        if (String(url).includes("/protection/bulk")) {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return Response.json({
            sourceId: "s-1",
            action: "include",
            matched: 2,
            updated: 2,
            sync: null,
          });
        }
        return new Response("{}", { status: 404 });
      },
    });
    await check("Alice Example");
    await check("Bob OneDrive");
    await act(async () => {
      action("include")?.click();
    });
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Include 2 objects?");
    await act(async () => {
      dialog?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/directory/sources/s-1/protection/bulk");
    expect(calls[0]?.body).toEqual({ action: "include", objectIds: ["o-1", "o-2"] });
    expect(panel()).toBeNull();
    expect(announcement()).toBe("Selection cleared");
    expect(document.activeElement).toBe(checkbox("Bob OneDrive"));
  });

  it("offers the rest in a menu that does not lock the page", async () => {
    wide(false);
    await mount(PAGE);
    await check("Alice Example");
    const more = action("moreSelectionActions") as HTMLElement;
    expect(more.getAttribute("aria-label")).toBe("More actions");
    await act(async () => {
      more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.querySelector('[data-action="reset"]')?.textContent).toBe(
      "Follow the rules again",
    );
    expect(menu?.querySelector('[data-action="newJobFromSelection"]')?.getAttribute("href")).toBe(
      "/jobs?type=mail&new=1&select=o-1",
    );
    // Not modal: no scroll lock on the page while it is open.
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("docks in the section column on a wide screen, with a way to it before the list", async () => {
    wide(true);
    const slot = document.createElement("div");
    slot.dataset.slot = "section-aside";
    document.body.appendChild(slot);
    await mount(PAGE, [SOURCE], {}, () => {}, {
      wrap: (content) => <SectionAsideProvider slot={slot}>{content}</SectionAsideProvider>,
    });
    expect(slot.childElementCount).toBe(0);
    await check("Alice Example");
    const docked = panel();
    expect(docked?.dataset.variant).toBe("column");
    expect(slot.contains(docked)).toBe(true);
    expect(docked?.textContent).toContain("Esc clears the selection");
    expect(action("include")?.textContent).toBe("Include");
    expect(action("reset")?.textContent).toBe("Follow the rules again");
    // Focus stays on the checkbox; a button right before the table leads to the panel's first
    // action (not to its clear button, where a second Enter would drop the selection).
    const jump = document.querySelector<HTMLElement>('[data-action="jumpToSelectionActions"]');
    expect(jump?.textContent).toBe("Go to the actions for the selection");
    const table = document.querySelector("table") as HTMLElement;
    expect(
      (jump?.compareDocumentPosition(table) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await act(async () => {
      jump?.click();
    });
    expect(document.activeElement?.getAttribute("data-action")).toBe("include");
    expect(docked?.contains(document.activeElement)).toBe(true);
    await press(document.activeElement as HTMLElement, "Escape");
    expect(slot.childElementCount).toBe(0);
  });

  it("stays closed in the section column for a viewer who may only look", async () => {
    wide(true);
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    await mount(PAGE, [SOURCE], {}, () => {}, {
      wrap: (content) => (
        <SectionAsideProvider slot={slot}>
          <ReadOnlyGroup closed>{content}</ReadOnlyGroup>
        </SectionAsideProvider>
      ),
    });
    await check("Alice Example");
    const docked = panel();
    expect(slot.contains(docked)).toBe(true);
    expect(docked?.closest("fieldset")?.disabled).toBe(true);
  });

  it("offers only the confirmation and the jobs tenant-wide, where no source is chosen", async () => {
    wide(false);
    await mount(
      {
        ...PAGE,
        items: [
          object({ status: "orphaned", inactiveState: "to_confirm", displayName: "Gone One" }),
        ],
        total: 1,
      },
      [SOURCE, { ...SOURCE, id: "s-2", name: "Fabrikam" }],
      { status: "to_confirm" },
    );
    await check("Gone One");
    expect(action("include")).toBeNull();
    expect(action("exclude")).toBeNull();
    const more = action("moreSelectionActions") as HTMLElement;
    await act(async () => {
      more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.querySelector('[data-action="confirmInactive"]')?.textContent).toBe(
      "Yes, intended",
    );
    expect(menu?.querySelector('[data-action="newJobFromSelection"]')).not.toBeNull();
    expect(menu?.querySelector('[data-action="addSelectionToJob"]')).not.toBeNull();
    expect(menu?.querySelector('[data-action="reset"]')).toBeNull();
  });

  it("reaches past the page once all of it is checked, and then offers no job", async () => {
    wide(false);
    await mount({ ...PAGE, total: 60 });
    await check("Alice Example");
    expect(document.querySelector('[data-action="selectAllMatching"]')).toBeNull();
    await check("Bob OneDrive");
    const more = action("moreSelectionActions") as HTMLElement;
    await act(async () => {
      more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    const all = document.querySelector<HTMLElement>(
      '[role="menu"] [data-action="selectAllMatching"]',
    );
    expect(all?.textContent).toBe("Select all 60 matching objects");
    await act(async () => {
      all?.click();
    });
    expect(panel()?.querySelector('[data-slot="selection-count"]')?.textContent).toContain(
      "60 selected",
    );
    expect(announcement()).toBe("60 selected");
    await act(async () => {
      action("moreSelectionActions")?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });
    // A job is made of explicit objects: "all matching" has none to hand over.
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.querySelector('[data-action="newJobFromSelection"]')).toBeNull();
    expect(menu?.querySelector('[data-action="reset"]')).not.toBeNull();
  });
});

describe("Back up now in the menu of an object", () => {
  const backupNow = () => entry("backupNow");

  it("starts a backup of exactly this object and says so", async () => {
    const calls: { url: string; body: unknown }[] = [];
    await mount(PAGE, [SOURCE], {}, () => {}, {
      fetch: async (url, init) => {
        if (!String(url).includes("/jobs/backup")) {
          return new Response("{}", { status: 404 });
        }
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(
          JSON.stringify({ queued: [{ jobId: "j-1", protectedObjectId: "o-1" }], skipped: [] }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      },
    });
    await rightClick(row("Alice Example").querySelectorAll("td")[2] as HTMLElement);
    expect(backupNow()?.textContent).toContain("Back up now");
    expect(backupNow()?.hasAttribute("data-disabled")).toBe(false);
    await act(async () => {
      backupNow()?.click();
    });
    await settle();
    const post = calls.find((call) => call.url.includes("/jobs/backup"));
    expect(post?.body).toEqual({ protectedObjectId: "o-1", full: false });
  });

  it("is not offered for excluded and no longer backed up objects", async () => {
    await mount({
      ...PAGE,
      items: [
        object({ status: "excluded", displayName: "Excluded Mailbox" }),
        object({ id: "o-2", status: "orphaned", displayName: "Gone Mailbox" }),
      ],
    });
    await rightClick(row("Excluded Mailbox").querySelectorAll("td")[2] as HTMLElement);
    expect(backupNow()).toBeNull();
    await rightClick(row("Gone Mailbox").querySelectorAll("td")[2] as HTMLElement);
    expect(backupNow()).toBeNull();
  });

  it("is closed with the reason for a disabled source", async () => {
    await mount(PAGE, [{ ...SOURCE, status: "disabled" }]);
    await rightClick(row("Alice Example").querySelectorAll("td")[2] as HTMLElement);
    expect(backupNow()?.hasAttribute("data-disabled")).toBe(true);
    expect(backupNow()?.textContent).toContain("Source disabled");
  });

  it("is closed for an IMAP account without a password and for a backup already queued", async () => {
    await mount({
      ...PAGE,
      items: [
        object({
          kind: "imap",
          sourceKind: "imap",
          displayName: "Imap Account",
          credential: {
            authMode: "per_mailbox",
            hasPassword: false,
            status: null,
            checkedAt: null,
            error: null,
            errorReason: null,
            failure: null,
          },
        }),
        object({
          id: "o-2",
          displayName: "Busy Mailbox",
          latestBackupJob: {
            id: "j-9",
            status: "queued",
            at: "2026-10-29T02:00:00.000Z",
            failure: null,
          },
        }),
      ],
    });
    await rightClick(row("Imap Account").querySelectorAll("td")[2] as HTMLElement);
    expect(backupNow()?.hasAttribute("data-disabled")).toBe(true);
    expect(backupNow()?.textContent).toContain("no password");
    await rightClick(row("Busy Mailbox").querySelectorAll("td")[2] as HTMLElement);
    expect(backupNow()?.hasAttribute("data-disabled")).toBe(true);
    expect(backupNow()?.textContent).toContain("Waiting to start");
  });

  it("stays open in the demo, as on the backup page", async () => {
    await mount(PAGE, [SOURCE], {}, () => {}, { demo: true });
    await rightClick(row("Alice Example").querySelectorAll("td")[2] as HTMLElement);
    expect(backupNow()?.hasAttribute("data-disabled")).toBe(false);
  });

  it("is closed with the reason for a source that is not connected yet", async () => {
    await mount(PAGE, [{ ...SOURCE, status: "pending" }]);
    await rightClick(row("Alice Example").querySelectorAll("td")[2] as HTMLElement);
    expect(backupNow()?.hasAttribute("data-disabled")).toBe(true);
    expect(backupNow()?.textContent).toContain("Source not connected yet");
  });

  describe("feedback and refresh", () => {
    const run = async (respond: () => Response) => {
      let objectsFetched = 0;
      await mount(PAGE, [SOURCE], {}, () => {}, {
        fetch: async (url) => {
          if (String(url).includes("/jobs/backup")) {
            return respond();
          }
          if (String(url).includes("/directory/objects")) {
            objectsFetched += 1;
            return new Response(JSON.stringify(PAGE), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("{}", { status: 404 });
        },
      });
      await rightClick(row("Alice Example").querySelectorAll("td")[2] as HTMLElement);
      await act(async () => {
        backupNow()?.click();
      });
      await settle();
      return () => objectsFetched;
    };

    it("says it was queued and refreshes the rows", async () => {
      const success = vi.spyOn(toast, "success").mockImplementation(() => "");
      const fetched = await run(
        () =>
          new Response(
            JSON.stringify({ queued: [{ jobId: "j-1", protectedObjectId: "o-1" }], skipped: [] }),
            { status: 202, headers: { "content-type": "application/json" } },
          ),
      );
      expect(success).toHaveBeenCalledWith("Backup queued for Alice Example.", expect.anything());
      expect(fetched()).toBeGreaterThan(0);
    });

    it("says it is already queued on a 409", async () => {
      const error = vi.spyOn(toast, "error").mockImplementation(() => "");
      await run(
        () =>
          new Response(JSON.stringify({ status: 409, reason: "already_queued" }), {
            status: 409,
            headers: { "content-type": "application/problem+json" },
          }),
      );
      expect(error).toHaveBeenCalledWith(
        "A backup of this object is already queued or running.",
        expect.anything(),
      );
    });

    it("says it failed on a server error", async () => {
      const error = vi.spyOn(toast, "error").mockImplementation(() => "");
      await run(
        () =>
          new Response(JSON.stringify({ status: 500 }), {
            status: 500,
            headers: { "content-type": "application/problem+json" },
          }),
      );
      expect(error).toHaveBeenCalledWith("The action could not be completed.", expect.anything());
    });
  });
});
