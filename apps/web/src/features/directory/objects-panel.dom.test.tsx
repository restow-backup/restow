// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type * as React from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { i18n } from "@/i18n";

import { directoryKeys } from "./api";
import "./i18n";
import { ObjectsPanel } from "./objects-panel";
import { toObjectsQuery } from "./search";
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
    }: { to: string; search?: Record<string, unknown>; children: React.ReactNode }) => {
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
});

async function mount(page: ObjectsPage) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(directoryKeys.objectsPage("t-1", toObjectsQuery({})), page);
  client.setQueryData(["setup", "state"], {
    configured: true,
    demo: { enabled: false, email: null, password: null },
  });
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <TooltipProvider delayDuration={200}>
            <ObjectsPanel
              search={{}}
              onSearchChange={() => {}}
              sources={[SOURCE]}
              onShowSources={() => {}}
            />
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
