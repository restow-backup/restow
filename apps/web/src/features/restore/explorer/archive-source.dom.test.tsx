// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SnapshotObject } from "@/features/restore/api";
import { i18n } from "@/i18n";

import {
  ArchiveGapList,
  ArchiveRestoreDialog,
  type ArchiveRestoreRequest,
  holdsArchivedMail,
  useArchiveSourceAvailable,
} from "./archive-source.js";

/**
 * The restore explorer's source "From the archive" (#48): what an administrator sees of a
 * mailbox's archived mail since its newest backup, how messages go back into the mailbox,
 * and that nobody else is offered the source at all.
 */

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigate };
});

const session = vi.hoisted(() => ({ role: "tenant_admin", provider: false }));
vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", role: session.role },
    isProviderAdmin: session.provider,
  }),
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    apiFetch: (path: string, init?: unknown) => apiFetch(path, init),
    setupStateQueryOptions: {
      ...actual.setupStateQueryOptions,
      queryFn: () => Promise.resolve({ demo: { enabled: false } }),
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const mailbox: SnapshotObject = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "mailbox",
  externalId: "anna@contoso.test",
  displayName: "Anna",
  status: "active",
  sourceKind: "m365",
  ownerEmail: "anna@contoso.test",
  own: false,
  snapshotCount: 3,
  latestSnapshotId: "s-3",
  latestSnapshotAt: "2026-11-03T21:00:00.000Z",
  readiness: { state: "unknown" } as unknown as SnapshotObject["readiness"],
};

const gapItems = ["Late offer", "Re: Late offer"].map((subject, index) => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${index}`,
  subject,
  from: "sender@example.org",
  to: ["anna@contoso.test"],
  cc: [],
  receivedAt: `2026-11-04T0${index + 7}:00:00.000Z`,
  sentAt: null,
  hasAttachment: false,
  sizeBytes: 2048,
  flags: [],
  source: index === 0 ? "graph_sync" : "journal",
  // The first one was in the mailbox before the backup began and reached the archive after.
  inBackup: index === 0,
}));

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function Available({ onValue }: { onValue: (value: boolean) => void }) {
  const available = useArchiveSourceAvailable();
  React.useEffect(() => {
    onValue(available);
  }, [available, onValue]);
  return null;
}

describe("holdsArchivedMail", () => {
  it("holds mail of mailboxes and IMAP accounts, not of drives or imported mailboxes", () => {
    expect(holdsArchivedMail({ kind: "mailbox", sourceKind: "m365" })).toBe(true);
    expect(holdsArchivedMail({ kind: "imap", sourceKind: "imap" })).toBe(true);
    expect(holdsArchivedMail({ kind: "imap", sourceKind: "import" })).toBe(false);
    expect(holdsArchivedMail({ kind: "onedrive", sourceKind: "m365" })).toBe(false);
  });
});

describe("the explorer's source From the archive", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  function unmount() {
    const current = root;
    if (current) {
      act(() => current.unmount());
    }
    container?.remove();
    root = null;
    container = null;
  }

  async function mount(node: React.ReactNode, until?: () => boolean) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const element = document.createElement("div");
    document.body.appendChild(element);
    const created = createRoot(element);
    container = element;
    root = created;
    await act(async () => {
      created.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
        </QueryClientProvider>,
      );
      await flush();
    });
    for (let attempt = 0; attempt < 10 && until && !until(); attempt += 1) {
      await act(async () => {
        await flush();
      });
    }
  }

  const el = () => container as HTMLDivElement;

  beforeEach(() => {
    session.role = "tenant_admin";
    session.provider = false;
    apiFetch.mockImplementation((path: string) => {
      if (path === "/navigation") {
        return Promise.resolve({ offers: { archive: true } });
      }
      if (path.startsWith("/archive/gap")) {
        return Promise.resolve({
          objectId: mailbox.id,
          since: "2026-11-03T20:00:00.000Z",
          snapshotId: "s-3",
          items: gapItems,
          total: gapItems.length,
          limit: 50,
          offset: 0,
        });
      }
      if (path === "/restore/archive") {
        return Promise.resolve({
          id: "r-1",
          jobId: "j-1",
          status: "queued",
          impersonated: true,
          selection: { all: false, folders: 0, items: 2 },
        });
      }
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    unmount();
    vi.clearAllMocks();
  });

  it("is offered to administrators of a tenant with an archive only", async () => {
    const seen: boolean[] = [];
    await mount(<Available onValue={(value) => seen.push(value)} />, () => seen.at(-1) === true);
    expect(seen.at(-1)).toBe(true);
    unmount();

    for (const role of ["tenant_restore", "tenant_user"]) {
      session.role = role;
      const values: boolean[] = [];
      await mount(<Available onValue={(value) => values.push(value)} />);
      expect(values.every((value) => value === false)).toBe(true);
      unmount();
    }
    // Nobody but an administrator asks the archive for anything.
    expect(apiFetch.mock.calls.some(([path]) => String(path).startsWith("/archive"))).toBe(false);

    session.role = "tenant_admin";
    apiFetch.mockImplementation(() => Promise.resolve({ offers: { archive: false } }));
    const hidden: boolean[] = [];
    await mount(<Available onValue={(value) => hidden.push(value)} />);
    expect(hidden.every((value) => value === false)).toBe(true);
  });

  it("lists the mail since the newest backup and puts the selected messages back", async () => {
    const onRestore = vi.fn();
    const onOpen = vi.fn();
    await mount(
      <ArchiveGapList
        object={mailbox}
        openItemId={null}
        onOpen={onOpen}
        onBack={vi.fn()}
        onRestore={onRestore}
      />,
      () => el().querySelectorAll('[data-slot="archive-gap-row"]').length > 0,
    );
    expect(apiFetch).toHaveBeenCalledWith(
      `/archive/gap?object=${mailbox.id}&limit=50&offset=0`,
      undefined,
    );
    const rows = [...el().querySelectorAll('[data-slot="archive-gap-row"]')];
    expect(rows.map((row) => row.querySelector("td:nth-child(2) button")?.textContent)).toEqual([
      expect.stringContaining("Late offer"),
      expect.stringContaining("Re: Late offer"),
    ]);
    expect(el().textContent).toContain("2 mails reached the archive since the newest backup");
    expect(el().textContent).toContain("Graph sync");
    expect(el().textContent).toContain("Read only");
    // Marked, not hidden, and never green: the backup holds the first one already.
    const marked = [...el().querySelectorAll('[data-slot="archive-gap-in-backup"]')];
    expect(marked).toHaveLength(1);
    expect(rows[0]?.contains(marked[0] ?? null)).toBe(true);
    expect(marked[0]?.textContent).toBe("Already in the backup");
    expect(marked[0]?.className).not.toContain("success");

    const restore = el().querySelector(
      '[data-slot="archive-restore-selected"]',
    ) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    await act(async () => {
      (rows[1]?.querySelector('[role="checkbox"]') as HTMLElement | null)?.click();
      await flush();
    });
    expect(restore.disabled).toBe(false);
    await act(async () => {
      restore.click();
      await flush();
    });
    expect(onRestore).toHaveBeenCalledWith([gapItems[1]?.id]);

    await act(async () => {
      (rows[0]?.querySelector("td:nth-child(2) button") as HTMLElement | null)?.click();
      await flush();
    });
    expect(onOpen).toHaveBeenCalledWith(gapItems[0]?.id);
  });

  it("asks for a reason for another person's mail and requests the restore into a new folder", async () => {
    const request: ArchiveRestoreRequest = {
      object: mailbox,
      itemIds: gapItems.map((item) => item.id),
    };
    await mount(<ArchiveRestoreDialog request={request} onClose={vi.fn()} />);
    const body = () => document.body.textContent ?? "";
    expect(body()).toContain("The 2 messages go back into Anna");
    expect(body()).toContain("The archived message, its retention period and any legal hold");

    const form = document.body.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.requestSubmit();
      await flush();
    });
    expect(apiFetch.mock.calls.some(([path]) => path === "/restore/archive")).toBe(false);
    expect(body()).toContain("Enter a reason");

    const reason = document.body.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(reason, "Ticket 4801");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });
    await act(async () => {
      form.requestSubmit();
      await flush();
      await flush();
    });
    const call = apiFetch.mock.calls.find(([path]) => path === "/restore/archive");
    expect(call?.[1]).toMatchObject({
      method: "POST",
      body: {
        objectId: mailbox.id,
        itemIds: request.itemIds,
        reason: "Ticket 4801",
        options: {
          restoreFolderName: expect.stringMatching(/^From the archive \d{4}-\d{2}-\d{2} \d{4}$/),
        },
      },
    });
    expect(navigate).toHaveBeenCalled();
  });
});
