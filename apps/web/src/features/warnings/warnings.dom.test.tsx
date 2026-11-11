// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { Failure } from "@/features/failures";
import { type HeldBackups, heldBackupKeys } from "@/features/held-backups/api";
import { i18n } from "@/i18n";

import type { WarningDetail, WarningList } from "./api";
import { warningKeys } from "./api";
import { WarningDetailBody } from "./components/warning-detail";
import "./i18n";
import { WarningsPage } from "./pages/warnings-page";

/**
 * The warnings in the browser: the reasons of one object (failed items with folder, subject and
 * date, the causes with what to do, the raw message), acknowledging it and why that can be
 * closed, and the list with a bulk acknowledgement that sends the selected objects and the note.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = {
  status: "authenticated",
  activeTenant: { id: "t-1", name: "Contoso" },
  role: "tenant_admin",
  isProviderAdmin: false,
};

vi.mock("@/lib/session", () => ({
  useSession: () => session,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      search: _search,
      activeOptions: _activeOptions,
      ...props
    }: {
      to: string;
      children: React.ReactNode;
      search?: unknown;
      activeOptions?: unknown;
    }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});

function failure(code: string, technical: Record<string, string | number> = {}): Failure {
  return {
    code,
    category: "microsoft",
    transient: false,
    retryable: false,
    params: {},
    technical,
    occurredAt: "2026-10-07T09:00:00.000Z",
    step: "download",
    retry: null,
    steps: [{ id: "item_stays_failed", target: null }],
    docsUrl: "https://docs.example/troubleshooting/",
  };
}

function detail(overrides: Partial<WarningDetail> = {}): WarningDetail {
  return {
    target: { kind: "object", id: "o-1", subjectKind: "mailbox", name: "Anna", detail: null },
    state: "open",
    latestRun: {
      id: "r-2",
      outcome: "partial",
      finishedAt: "2026-10-07T10:00:00.000Z",
      failedItems: 1,
    },
    causes: [{ code: "graph.item_too_large", count: 1 }],
    newCauses: ["graph.item_too_large"],
    acknowledgement: null,
    runs: [
      {
        id: "r-2",
        outcome: "partial",
        startedAt: "2026-10-07T09:50:00.000Z",
        finishedAt: "2026-10-07T10:00:00.000Z",
        failedItems: 1,
        failure: null,
      },
    ],
    focusRunId: "r-2",
    items: [
      {
        ref: "mail/Inbox/Projects/Quarterly report.0123456789abcdef.eml",
        location: {
          area: "mail",
          folder: "Inbox/Projects",
          name: "Quarterly report",
          itemId: "0123456789abcdef",
        },
        itemDate: "2026-09-01T08:00:00.000Z",
        failedAt: "2026-10-07T09:59:00.000Z",
        attempts: 3,
        message: "Graph 413 ErrorMessageSizeExceeded: too large",
        failure: failure("graph.item_too_large", { errorCode: "ErrorMessageSizeExceeded" }),
      },
    ],
    itemCount: 1,
    groups: [{ failure: failure("graph.item_too_large"), count: 1 }],
    acknowledge: { allowed: true, refusal: null },
    docsUrl: "https://docs.example/troubleshooting/",
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let requests: { url: string; method: string; body: unknown }[] = [];

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  session.role = "tenant_admin";
  requests = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.includes("/run-size/holds/") && url.endsWith("/continue")) {
      return new Response(JSON.stringify({ id: "h-1", status: "approved" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/warnings/acknowledge")) {
      return new Response(JSON.stringify({ acknowledged: [{}], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mount(node: React.ReactNode, seed?: (client: QueryClient) => void) {
  // Seeded data stays fresh: a refetch would hit the 404 fallback and race the assertions.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  seed?.(client);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <TooltipProvider delayDuration={200}>{node}</TooltipProvider>
        </I18nextProvider>
      </QueryClientProvider>,
    );
  });
}

const text = () => document.body.textContent ?? "";

/** The table renders a tick after the page under load; wait for a text instead of reading once. */
async function waitForText(expected: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!text().includes(expected) && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  expect(text()).toContain(expected);
}
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );

describe("the reasons of a warning", () => {
  it("names each failed item with folder, subject, date, cause, what to do and the raw message", async () => {
    await mount(<WarningDetailBody detail={detail()} />);
    expect(text()).toContain("Warning");
    expect(text()).toContain("could not be backed up");
    const item = document.querySelector('[data-item^="mail/Inbox/Projects"]');
    expect(item?.textContent).toContain("Quarterly report");
    expect(item?.textContent).toContain("Inbox/Projects");
    expect(item?.textContent).toContain("ID 0123456789abcdef");
    expect(item?.textContent).toContain("Received");
    expect(item?.textContent).toContain("in 3 runs in a row");
    expect(item?.querySelector("details")?.textContent).toContain("ErrorMessageSizeExceeded");
    // The cause group explains why and what to do.
    const group = document.querySelector(
      '[data-section="causes"] [data-cause="graph.item_too_large"]',
    );
    expect(group?.textContent).toContain("1 item not backed up");
    expect(group?.textContent?.length ?? 0).toBeGreaterThan(40);
    expect(document.querySelector('[data-run="r-2"] a')?.getAttribute("href")).toBe("/history/r-2");
    const acknowledge = button("Acknowledge warning");
    expect(acknowledge?.disabled).toBe(false);
  });

  it("cannot acknowledge a failed backup, and says why", async () => {
    await mount(
      <WarningDetailBody
        detail={detail({
          state: "failed",
          latestRun: {
            id: "r-3",
            outcome: "failed",
            finishedAt: "2026-10-07T11:00:00.000Z",
            failedItems: 0,
          },
          causes: [],
          newCauses: [],
          items: [],
          itemCount: 0,
          groups: [],
          focusRunId: "r-3",
          runs: [
            {
              id: "r-3",
              outcome: "failed",
              startedAt: null,
              finishedAt: "2026-10-07T11:00:00.000Z",
              failedItems: 0,
              failure: failure("graph.access_denied"),
            },
          ],
          acknowledge: { allowed: false, refusal: "failed" },
        })}
      />,
    );
    expect(text()).toContain("The last backup failed");
    const acknowledge = button("Acknowledge warning");
    expect(acknowledge?.disabled).toBe(true);
    expect(acknowledge?.closest('[data-slot="disabled-reason"]')).not.toBeNull();
  });

  it("closes acknowledging for a role that may not", async () => {
    session.role = "tenant_user";
    await mount(<WarningDetailBody detail={detail()} />);
    expect(button("Acknowledge warning")?.disabled).toBe(true);
  });

  it("shows who acknowledged, when, the note, and offers to revoke", async () => {
    await mount(
      <WarningDetailBody
        detail={detail({
          state: "acknowledged",
          newCauses: [],
          acknowledgement: {
            acknowledgedAt: "2026-10-07T10:30:00.000Z",
            acknowledgedBy: "admin@contoso.example",
            note: "Too large, accepted.",
            causes: ["graph.item_too_large"],
            runId: "r-2",
            superseded: false,
          },
        })}
      />,
    );
    expect(text()).toContain("Acknowledged by admin@contoso.example");
    expect(text()).toContain("Too large, accepted.");
    expect(button("Acknowledge warning")).toBeUndefined();
    expect(button("Revoke acknowledgement")?.disabled).toBe(false);
  });

  it("says when an acknowledgement no longer applies and names the new cause", async () => {
    await mount(
      <WarningDetailBody
        detail={detail({
          newCauses: ["graph.throttled"],
          acknowledgement: {
            acknowledgedAt: "2026-10-06T10:30:00.000Z",
            acknowledgedBy: "admin@contoso.example",
            note: null,
            causes: ["graph.item_too_large"],
            runId: "r-1",
            superseded: true,
          },
        })}
      />,
    );
    expect(text()).toContain("no longer applies");
    expect(text()).toContain("New cause:");
    expect(button("Acknowledge again")?.disabled).toBe(false);
  });
});

describe("the list of warnings", { timeout: 20_000 }, () => {
  const LIST: WarningList = {
    items: [
      {
        ...detail(),
      },
      {
        ...detail({
          target: {
            kind: "machine",
            id: "m-1",
            subjectKind: "server",
            name: "Fileserver",
            detail: "linux",
          },
          causes: [{ code: "endpoint.read_error", count: 4 }],
        }),
      },
    ],
    counts: { open: 2, acknowledged: 0, failed: 1, failedGuests: 2 },
    truncated: false,
  };

  it("acknowledges the selected objects with a note", async () => {
    await mount(<WarningsPage state="open" />, (client) =>
      client.setQueryData(warningKeys.list("t-1", "open"), LIST),
    );
    await waitForText("Anna");
    expect(text()).toContain("Fileserver");
    // A failed backup is pointed out, not offered for acknowledging.
    expect(document.querySelector('[data-slot="failed-hint"]')?.textContent).toContain(
      "cannot be acknowledged",
    );
    // So is a failed backup of a VM or container, with the way to its page.
    const guests = document.querySelector('[data-slot="failed-guests-hint"]');
    expect(guests?.textContent).toContain("2 VMs or containers in a backup job have");
    expect(guests?.querySelector("a")?.getAttribute("href")).toBe("/virtualization");
    const bulk = button("Acknowledge 0 warnings");
    expect(bulk?.disabled).toBe(true);

    const checkboxes = [...document.querySelectorAll<HTMLElement>('tbody [role="checkbox"]')];
    await act(async () => {
      for (const box of checkboxes) box.click();
    });
    await act(async () => {
      button("Acknowledge 2 warnings")?.click();
    });
    const note = document.querySelector<HTMLTextAreaElement>("textarea");
    expect(note).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(note, "Known, accepted.");
      note?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>('[data-slot="acknowledge-dialog"] button')]
        .find((candidate) => candidate.textContent === "Acknowledge")
        ?.click();
    });
    const sent = requests.find((request) => request.url.endsWith("/warnings/acknowledge"));
    expect(sent?.method).toBe("POST");
    expect(sent?.body).toEqual({
      targets: [
        { kind: "object", id: "o-1" },
        { kind: "machine", id: "m-1" },
      ],
      note: "Known, accepted.",
    });
  });

  it("shows the acknowledged ones with who and the note, without selection", async () => {
    const acknowledged: WarningList = {
      items: [
        detail({
          state: "acknowledged",
          acknowledgement: {
            acknowledgedAt: "2026-10-07T10:30:00.000Z",
            acknowledgedBy: "admin@contoso.example",
            note: "Too large, accepted.",
            causes: ["graph.item_too_large"],
            runId: "r-2",
            superseded: false,
          },
        }),
      ],
      counts: { open: 0, acknowledged: 1, failed: 0 },
      truncated: false,
    };
    await mount(<WarningsPage state="acknowledged" />, (client) =>
      client.setQueryData(warningKeys.list("t-1", "acknowledged"), acknowledged),
    );
    await waitForText("admin@contoso.example");
    expect(text()).toContain("Too large, accepted.");
    expect(document.querySelector('tbody [role="checkbox"]')).toBeNull();
  });
});

describe("held backups (#99)", { timeout: 20_000 }, () => {
  const HELD: HeldBackups = {
    open: [
      {
        id: "h-1",
        objectKind: "endpoint",
        objectId: "m-1",
        objectName: "Fileserver",
        runId: "r-9",
        reason: "size",
        status: "pending",
        bytes: 879 * 1024 ** 3,
        limitBytes: 20 * 1024 ** 3,
        medianBytes: 2 * 1024 ** 3,
        historyRuns: 10,
        freeBytes: null,
        totalBytes: null,
        refusedRuns: 2,
        heldAt: "2026-11-10T22:00:00.000Z",
        lastRefusedAt: "2026-11-11T22:00:00.000Z",
        approvedAt: null,
        approvedBy: null,
        note: null,
        resolution: null,
        resolvedAt: null,
      },
    ],
    recent: [],
  };
  const EMPTY_LIST: WarningList = {
    items: [],
    counts: { open: 0, acknowledged: 0, failed: 0 },
    truncated: false,
  };

  it("shows what the held run added and what is usual, and lets it continue once", async () => {
    await mount(<WarningsPage state="open" />, (client) => {
      client.setQueryData(warningKeys.list("t-1", "open"), EMPTY_LIST);
      client.setQueryData(heldBackupKeys.holds("t-1"), HELD);
    });
    await waitForText("Held backups");
    const row = document.querySelector('[data-slot="held-backup"]');
    expect(row?.getAttribute("data-status")).toBe("pending");
    expect(row?.textContent).toContain("Fileserver");
    expect(row?.textContent).toContain("Would add more than 20 GB");
    expect(row?.textContent).toContain("879 GB so far, usually 2 GB");
    expect(row?.textContent).toContain("2 later runs held");
    await act(async () => {
      button("Continue once")?.click();
    });
    const sent = requests.find((request) => request.url.endsWith("/run-size/holds/h-1/continue"));
    expect(sent?.method).toBe("POST");
  });

  it("offers nothing to decide to an end user, and says when nothing is held", async () => {
    session.role = "end_user";
    await mount(<WarningsPage state="open" />, (client) => {
      client.setQueryData(warningKeys.list("t-1", "open"), EMPTY_LIST);
      client.setQueryData(heldBackupKeys.holds("t-1"), HELD);
    });
    await waitForText("Held backups");
    expect(button("Continue once")?.disabled).toBe(true);
    expect(button("Raise the limit")?.disabled).toBe(true);
    act(() => root?.unmount());
    root = null;
    session.role = "tenant_admin";
    await mount(<WarningsPage state="open" />, (client) => {
      client.setQueryData(warningKeys.list("t-1", "open"), EMPTY_LIST);
      client.setQueryData(heldBackupKeys.holds("t-1"), { open: [], recent: [] });
    });
    await waitForText("No backup is held");
  });

  it("offers no limit for a hold for space, and says it ends by itself (review 2)", async () => {
    const space: HeldBackups = {
      open: [
        {
          ...(HELD.open[0] as HeldBackups["open"][number]),
          reason: "space",
          limitBytes: null,
          freeBytes: 2 * 1024 ** 3,
          totalBytes: 100 * 1024 ** 3,
        },
      ],
      recent: [],
    };
    await mount(<WarningsPage state="open" />, (client) => {
      client.setQueryData(warningKeys.list("t-1", "open"), EMPTY_LIST);
      client.setQueryData(heldBackupKeys.holds("t-1"), space);
    });
    await waitForText("Held backups");
    // Continue once lifts the size check only: a hold for space waits for room (#99).
    expect(button("Continue once")?.disabled).toBe(true);
    expect(button("Raise the limit")).toBeUndefined();
    const note = document.querySelector('[data-slot="held-space-note"]')?.textContent;
    expect(note).toContain("ends by itself");
    expect(note).toContain("cannot be continued once");
  });

  describe("the space rule of the tenant (#99)", () => {
    const GIB = 1024 ** 3;
    const RULE = { enabled: true, percent: 5, minBytes: 20 * GIB, maxBytes: 500 * GIB };
    const settings = (sharedTarget: boolean) => ({
      defaults: {
        enabled: true,
        factor: 10,
        minHistory: 3,
        historyRuns: 10,
        minBytes: 10 * GIB,
        limitBytes: null,
        firstRunBytes: null,
      },
      tenant: null,
      effective: {
        enabled: true,
        factor: 10,
        minHistory: 3,
        historyRuns: 10,
        minBytes: 10 * GIB,
        limitBytes: null,
        firstRunBytes: null,
      },
      space: { defaults: RULE, installation: {}, override: null, effective: RULE, sharedTarget },
      objects: [],
    });
    const inputFor = (label: string) => {
      const element = [...document.querySelectorAll("label")].find((candidate) =>
        candidate.textContent?.includes(label),
      );
      return document.getElementById(element?.getAttribute("for") ?? "") as HTMLInputElement | null;
    };
    function setValue(element: HTMLInputElement, value: string) {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
        element,
        value,
      );
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    async function openSettings(sharedTarget: boolean) {
      await mount(<WarningsPage state="open" />, (client) => {
        client.setQueryData(warningKeys.list("t-1", "open"), EMPTY_LIST);
        client.setQueryData(heldBackupKeys.holds("t-1"), { open: [], recent: [] });
        client.setQueryData(heldBackupKeys.settings("t-1"), settings(sharedTarget));
      });
      await waitForText("Held backups");
      await act(async () => {
        button("Size check")?.click();
      });
      await waitForText("Free space on the storage targets of this tenant");
    }
    const saved = () =>
      requests.filter(
        (request) => request.url.endsWith("/run-size/settings") && request.method === "PUT",
      );

    it("sends the rule only once it was changed", async () => {
      await openSettings(false);
      expect(inputFor("Share of the target's size (%)")?.value).toBe("5");
      expect(inputFor("At least (GiB)")?.value).toBe("20");
      expect(inputFor("At most (GiB)")?.value).toBe("500");
      // Saving the size settings alone leaves the space rule following the installation.
      await act(async () => {
        button("Save")?.click();
      });
      expect(saved()[0]?.body).not.toHaveProperty("space");
      await act(async () => {
        setValue(inputFor("Share of the target's size (%)") as HTMLInputElement, "10");
      });
      await act(async () => {
        button("Save")?.click();
      });
      // Only what was changed becomes the tenant's own.
      expect(saved()[1]?.body).toEqual(expect.objectContaining({ space: { percent: 10 } }));
    });

    it("on the installation's shared target: says the installation's rule applies, no fields", async () => {
      await openSettings(true);
      expect(text()).toContain("shared default target");
      expect(text()).toContain("Keeps 5 % of the target free");
      expect(inputFor("Share of the target's size (%)")).toBeNull();
    });
  });
});
