// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { BellList, BellNotification } from "@/features/reports/api";
import {
  type Mounted,
  click,
  enableActEnvironment,
  flush,
  json,
  mount,
  routedFetch,
  sessionAs,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import {
  NotificationBell,
  bellBadgeClass,
  bellEventKey,
  isUpdateEvent,
  unreadAttentionCount,
} from "./notification-bell";

/**
 * The bell's installation-level entries: an update notification leads to
 * Settings, Updates and is marked read on the way; the others behave as before.
 */

const navigateSpy = vi.fn();

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
  };
});

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  navigateSpy.mockReset();
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function item(overrides: Partial<BellNotification>): BellNotification {
  return {
    id: "n1",
    tenantId: null,
    level: "info",
    event: "update.available",
    message: "Version 0.2.0 is available",
    details: { version: "0.2.0" },
    read: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function openBell(items: BellNotification[], extra: Partial<BellList> = {}) {
  const list: BellList = { items, unread: items.filter((entry) => !entry.read).length, ...extra };
  const { mock, requests } = routedFetch({
    "GET /notifications": () => json(list),
    "POST /notifications/read": () => json({ updated: 1 }),
  });
  vi.stubGlobal("fetch", mock);
  mounted = mount(<NotificationBell />, {
    session: sessionAs({
      activeTenant: {
        id: "t1",
        name: "Tenant",
        slug: "tenant",
        role: "tenant_admin",
        status: "active",
      },
    }),
  });
  await flush(5);
  await click(
    document.body.querySelector('button[aria-label*="otification"], button[aria-label*="ell"]'),
  );
  await flush(3);
  return requests;
}

const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

const popover = () => document.body.querySelector<HTMLElement>('[data-slot="popover-content"]');

/** The first entry of the list (its text is translated by the reports namespace, which this test does not depend on). */
const firstEntry = () => popover()?.querySelector<HTMLButtonElement>("ul button") ?? null;

describe("isUpdateEvent", () => {
  it("covers every notification about updates", () => {
    for (const event of ["update.available", "update.succeeded", "update.failed"]) {
      expect(isUpdateEvent(event), event).toBe(true);
    }
    for (const event of ["backup.failed", "report.ready", "updates", "restore.update"]) {
      expect(isUpdateEvent(event), event).toBe(false);
    }
  });
});

describe("bellEventKey", () => {
  it("words a red rating for a backup that is too old apart from a failed restore check", () => {
    expect(bellEventKey({ event: "verify.red", details: { redReason: "outdated" } })).toBe(
      "bellEvents.verify.redOutdated",
    );
    expect(bellEventKey({ event: "verify.red", details: { redReason: "damaged" } })).toBe(
      "bellEvents.verify.red",
    );
    expect(bellEventKey({ event: "verify.red", details: null })).toBe("bellEvents.verify.red");
    expect(bellEventKey({ event: "backup.failed", details: { redReason: "outdated" } })).toBe(
      "bellEvents.backup.failed",
    );
  });
});

describe("unreadAttentionCount", () => {
  it("is the server's count of unread warnings and errors", () => {
    expect(unreadAttentionCount({ items: [], unread: 12, unreadAttention: 3 })).toBe(3);
    expect(unreadAttentionCount({ items: [], unread: 12, unreadAttention: 0 })).toBe(0);
  });

  it("falls back to the unread warnings and errors among the entries it holds", () => {
    const items = [
      item({ id: "a", level: "info" }),
      item({ id: "b", level: "error", event: "backup.failed" }),
      item({ id: "c", level: "warning", event: "verify.yellow" }),
      item({ id: "d", level: "error", event: "backup.failed", read: true }),
    ];
    expect(unreadAttentionCount({ items, unread: 3 })).toBe(2);
  });

  it("is zero without unread entries and never above the unread count", () => {
    expect(unreadAttentionCount(undefined)).toBe(0);
    expect(unreadAttentionCount({ items: [], unread: 0, unreadAttention: 4 })).toBe(0);
    expect(unreadAttentionCount({ items: [], unread: 2, unreadAttention: 5 })).toBe(2);
  });
});

describe("bellBadgeClass", () => {
  it("is red for attention and the info tone otherwise", () => {
    expect(bellBadgeClass(1)).toContain("bg-destructive");
    expect(bellBadgeClass(0)).toContain("bg-info");
    expect(bellBadgeClass(0)).not.toContain("destructive");
  });
});

describe("the bell badge", () => {
  const badge = () =>
    document.body.querySelector<HTMLElement>(
      'button[aria-label*="otification"] span[aria-hidden="true"][data-tone]',
    );
  const label = () =>
    document.body.querySelector('button[aria-label*="otification"]')?.getAttribute("aria-label");

  it("is not red for unread information such as a completed restore", async () => {
    await openBell([
      item({
        id: "r1",
        event: "restore.completed",
        level: "info",
        message: "Restore completed: Mailbox",
        details: { objectName: "Mailbox" },
      }),
    ]);
    expect(badge()).not.toBeNull();
    expect(badge()?.textContent).toBe("1");
    expect(badge()?.getAttribute("data-tone")).toBe("info");
    expect(badge()?.className).toContain("bg-info");
    expect(badge()?.className).not.toContain("destructive");
    expect(label()).toBe("Notifications, 1 unread");
  });

  it("is red when an unread entry is a failure, and says how many need attention", async () => {
    await openBell(
      [
        item({ id: "r1", event: "restore.completed", level: "info", message: "Restore completed" }),
        item({
          id: "f1",
          event: "backup.failed",
          level: "error",
          message: "Backup failed: Mailbox",
          details: { objectName: "Mailbox" },
        }),
      ],
      { unreadAttention: 1 },
    );
    expect(badge()?.textContent).toBe("2");
    expect(badge()?.getAttribute("data-tone")).toBe("attention");
    expect(badge()?.className).toContain("bg-destructive");
    expect(label()).toBe("Notifications, 2 unread, 1 needs attention");
  });

  it("goes back to the info tone once the failure is read", async () => {
    await openBell(
      [
        item({ id: "r1", event: "restore.completed", level: "info", message: "Restore completed" }),
        item({
          id: "f1",
          event: "backup.failed",
          level: "error",
          message: "Backup failed",
          read: true,
        }),
      ],
      { unreadAttention: 0 },
    );
    expect(badge()?.textContent).toBe("1");
    expect(badge()?.getAttribute("data-tone")).toBe("info");
  });

  it("shows no badge without unread entries", async () => {
    await openBell([item({ read: true })]);
    expect(badge()).toBeNull();
    expect(label()).toBe("Notifications");
  });
});

describe("the bell", () => {
  it("takes an update notification to Settings, Updates and marks it read", async () => {
    const requests = await openBell([item({})]);
    const entry = firstEntry();
    expect(entry).not.toBeNull();

    await click(entry);
    await flush(3);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/settings", search: { section: "updates" } });
    const read = requests.find((request) => request.path === "/notifications/read");
    expect(read?.body).toEqual({ ids: ["n1"] });
    // The list closes so the page underneath is seen.
    expect(popover()).toBeNull();
  });

  it("sends every kind of update notification to the tab", async () => {
    for (const event of ["update.succeeded", "update.failed"]) {
      navigateSpy.mockReset();
      await openBell([item({ id: event, event, message: `About ${event}` })]);
      await click(firstEntry());
      await flush(3);
      expect(navigateSpy, event).toHaveBeenCalledWith({
        to: "/settings",
        search: { section: "updates" },
      });
      await mounted?.unmount();
      mounted = null;
      vi.unstubAllGlobals();
      document.body.innerHTML = "";
    }
  });

  it("still takes a notification that was already read to the tab, without marking it again", async () => {
    const requests = await openBell([item({ read: true })]);
    await click(firstEntry());
    await flush(3);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(requests.some((request) => request.path === "/notifications/read")).toBe(false);
  });

  it("leaves every other notification where it is", async () => {
    const requests = await openBell([
      item({
        id: "n2",
        event: "backup.failed",
        level: "error",
        message: "Backup failed: Mailbox",
        details: { objectName: "Mailbox" },
      }),
    ]);
    expect(text(firstEntry())).toContain("Backup failed: Mailbox");
    await click(firstEntry());
    await flush(3);
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(requests.find((request) => request.path === "/notifications/read")?.body).toEqual({
      ids: ["n2"],
    });
    expect(popover()).not.toBeNull();
  });
});

describe("the bell of a provider administrator without a tenant", () => {
  const bellButton = () =>
    document.body.querySelector<HTMLButtonElement>(
      'button[aria-label*="otification"], button[aria-label*="ell"]',
    );

  async function openWithoutTenant(
    items: BellNotification[],
    session = sessionAs({ activeTenant: null }),
  ) {
    const list: BellList = { items, unread: items.filter((entry) => !entry.read).length };
    const { mock, requests } = routedFetch({
      "GET /notifications/installation": () => json(list),
      "POST /notifications/installation/read": () => json({ updated: 1 }),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<NotificationBell />, { session });
    await flush(5);
    return requests;
  }

  it("shows the bell with the installation-level notifications, asking for no tenant", async () => {
    const requests = await openWithoutTenant([
      item({}),
      item({ id: "n2", event: "update.failed", level: "error", message: "The update failed" }),
    ]);
    expect(bellButton()).not.toBeNull();
    // Two unread entries, told to a screen reader by the label.
    expect(bellButton()?.getAttribute("aria-label")).toMatch(/2/);

    await click(bellButton());
    await flush(3);
    expect(popover()?.querySelectorAll("ul button")).toHaveLength(2);
    // Only the installation's list was asked for; the tenant's was never requested.
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /notifications/installation",
    ]);
    // The tenant's report rules are not reachable without a tenant.
    expect(popover()?.querySelector("a")).toBeNull();
  });

  it("marks an entry read on the installation endpoint and still leads an update to Settings", async () => {
    const requests = await openWithoutTenant([item({})]);
    await click(bellButton());
    await flush(3);
    await click(firstEntry());
    await flush(3);
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/settings", search: { section: "updates" } });
    const read = requests.find((request) => request.method === "POST");
    expect(read?.path).toBe("/notifications/installation/read");
    expect(read?.body).toEqual({ ids: ["n1"] });
  });

  it("marks all of them read on the installation endpoint", async () => {
    const requests = await openWithoutTenant([item({}), item({ id: "n2" })]);
    await click(bellButton());
    await flush(3);
    const markAll = [...(popover()?.querySelectorAll("button") ?? [])].find(
      (button) => !button.closest("ul") && !button.disabled,
    );
    await click(markAll ?? null);
    await flush(3);
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({ all: true });
  });

  it("has no bell for someone who is neither in a tenant nor a provider administrator", async () => {
    const requests = await openWithoutTenant(
      [item({})],
      sessionAs({ activeTenant: null, isProviderAdmin: false, role: null }),
    );
    expect(bellButton()).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("has no bell before the session is known", async () => {
    const requests = await openWithoutTenant(
      [item({})],
      sessionAs({ activeTenant: null, status: "loading" }),
    );
    expect(bellButton()).toBeNull();
    expect(requests).toHaveLength(0);
  });
});
