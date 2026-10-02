// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import type {
  EndpointReadinessRow,
  ObjectReadiness,
  ReadinessOverview,
} from "@/features/verify/api";
import { i18n } from "@/i18n";

import "./i18n";
import { VerifyPage } from "./verify-page";

/**
 * The readiness page counts one set of protected objects: the banner, the
 * four tiles and the table all describe the same mailboxes and machines.
 */

/** The address the page reads its filter from, and where it navigates to. */
const router = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
    useSearch: () => router.search,
    useNavigate: () => router.navigate,
    // What the tenant switch hook reads: the menu entries and the address.
    useRouter: () => ({ options: { context: { navItems: [] } } }),
    useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
      select({ location: { pathname: "/verify", search: router.search } }),
  };
});

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  router.search = {};
  router.navigate.mockReset();
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function mailbox(name: string): ObjectReadiness {
  return {
    object: {
      id: `o-${name}`,
      kind: "mailbox",
      displayName: name,
      externalId: `ext-${name}`,
      status: "active",
      email: `${name.toLowerCase()}@contoso.test`,
      upn: null,
    },
    state: "green",
    readiness: "green",
    checkedAt: "2026-09-29T03:00:00.000Z",
    overdue: false,
    latestSnapshotAt: "2026-09-29T02:00:00.000Z",
    report: { id: `r-${name}`, kind: "verify", origin: "verify", reasons: [], counts: null },
    running: null,
    latestSnapshotId: `s-${name}`,
    previousCheck: null,
  };
}

function machine(hostname: string): EndpointReadinessRow {
  return {
    id: `e-${hostname}`,
    hostname,
    displayName: null,
    profile: "server",
    os: "linux",
    state: "green",
    readiness: "green",
    checkedAt: "2026-09-29T03:00:00.000Z",
    overdue: false,
    latestBackupAt: "2026-09-29T02:00:00.000Z",
    latestSnapshotId: `s-${hostname}`,
  };
}

function overview(
  objects: ObjectReadiness[],
  endpoints: EndpointReadinessRow[],
): ReadinessOverview {
  const total = objects.length + endpoints.length;
  return {
    summary: {
      total,
      green: total,
      yellow: 0,
      red: 0,
      unverified: 0,
      noBackup: 0,
      overdue: 0,
      overall: "green",
      lastCheckedAt: "2026-09-29T03:00:00.000Z",
      running: 0,
    },
    objects,
    endpoints,
    storage: { state: "ok", latest: null, lastFullAt: null, running: null, lastFailure: null },
    schedules: { backup: null, verify: null, scrub: null },
  };
}

async function open(
  data: ReadinessOverview,
  session: Parameters<typeof sessionAs>[0] = {},
): Promise<HTMLElement> {
  const { mock } = routedFetch({ "GET /verify/latest": () => json(data) });
  vi.stubGlobal("fetch", mock);
  mounted = mount(<VerifyPage />, {
    session: sessionAs({
      activeTenant: {
        id: "t1",
        name: "Contoso",
        slug: "contoso",
        kind: "customer",
        customerNumber: null,
        role: "tenant_admin",
        status: "active",
      },
      ...session,
    }),
  });
  await flush(6);
  return mounted.container;
}

const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ");

describe("the recovery readiness page", () => {
  it("counts the machines in the banner and in the table alike", async () => {
    const page = await open(overview([mailbox("Ada"), mailbox("Bob")], [machine("web-01")]));
    const content = text(page);
    // The banner counts every protected object, machines included ...
    expect(content).toContain("All 3 protected objects passed the latest restore check.");
    // ... and the table lists exactly those three.
    expect(chipCount(page, "all")).toBe("3");
    expect(page.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(content).toContain("web-01");
    expect(content).toContain("Server · Linux");
  });

  it("has no second table for servers and clients", async () => {
    const page = await open(overview([mailbox("Ada")], [machine("web-01")]));
    expect(page.querySelectorAll("table")).toHaveLength(1);
    expect(text(page)).not.toContain("Servers and clients");
  });

  it("is still consistent for a tenant with machines only", async () => {
    const page = await open(overview([], [machine("web-01"), machine("laptop-7")]));
    const content = text(page);
    expect(content).toContain("All 2 protected objects passed the latest restore check.");
    expect(chipCount(page, "all")).toBe("2");
  });

  it("is still consistent for a server that sends no machines", async () => {
    const data = overview([mailbox("Ada")], []);
    const { endpoints: _omitted, ...withoutEndpoints } = data;
    const page = await open(withoutEndpoints as ReadinessOverview);
    expect(chipCount(page, "all")).toBe("1");
  });
});

/** The figure on a state chip. */
const chipCount = (page: Element, state: string) =>
  page.querySelector(`[data-slot="state-chips"] [data-state="${state}"] .font-mono`)?.textContent;

/** A mixed tenant: one ready mailbox, one that cannot be restored, one never checked. */
function mixed(): ReadinessOverview {
  const red = { ...mailbox("Bob"), state: "red" as const, readiness: "red" as const };
  const unverified = {
    ...mailbox("Cy"),
    state: "unverified" as const,
    readiness: null,
    report: null,
    checkedAt: null,
  };
  const data = overview([mailbox("Ada"), red, unverified], []);
  return {
    ...data,
    summary: { ...data.summary, green: 1, red: 1, unverified: 1, overall: "red" },
  };
}

describe("the filter in the address", () => {
  it("shows every object without a state, and counts each state on its chip", async () => {
    const page = await open(mixed());
    expect(page.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(chipCount(page, "all")).toBe("3");
    expect(chipCount(page, "green")).toBe("1");
    expect(chipCount(page, "red")).toBe("1");
    expect(chipCount(page, "unverified")).toBe("1");
    expect(chipCount(page, "yellow")).toBe("0");
    expect(chipCount(page, "no_backup")).toBe("0");
  });

  it("filters the table to ?state=red and keeps the counts of the others", async () => {
    router.search = { state: "red" };
    const page = await open(mixed());
    const rows = page.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    expect(text(rows[0] as Element)).toContain("Bob");
    expect(chipCount(page, "green")).toBe("1");
    expect(page.querySelector('[data-state="red"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores a state it does not know instead of showing an empty table", async () => {
    router.search = { state: "purple" };
    const page = await open(mixed());
    expect(page.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it("puts the chosen state in the address, replacing the entry so Back does not bounce", async () => {
    const page = await open(mixed());
    await click(page.querySelector('[data-slot="state-chips"] [data-state="unverified"]'));
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/verify",
      search: { state: "unverified" },
      replace: true,
    });
  });

  it("takes the filter off again when the pressed chip is chosen once more, or All", async () => {
    router.search = { state: "red" };
    const page = await open(mixed());
    await click(page.querySelector('[data-slot="state-chips"] [data-state="red"]'));
    await click(page.querySelector('[data-slot="state-chips"] [data-state="all"]'));
    expect(router.navigate).toHaveBeenNthCalledWith(1, {
      to: "/verify",
      search: {},
      replace: true,
    });
    expect(router.navigate).toHaveBeenNthCalledWith(2, {
      to: "/verify",
      search: {},
      replace: true,
    });
  });
});

describe("the page across all tenants", () => {
  it("brings the session into All tenants for an address made for it, and shows no tenant table", async () => {
    router.search = { state: "red", scope: "all" };
    const setScopeAll = vi.fn();
    const page = await open(mixed(), { canViewAllTenants: true, setScopeAll });
    expect(setScopeAll).toHaveBeenCalledOnce();
    // The page of the tenant is not shown: this is the page across tenants.
    expect(page.querySelector('[data-slot="verify-all-tenants"]')).not.toBeNull();
    expect(page.querySelectorAll("table")).toHaveLength(0);
    expect(text(page)).toContain("Which tenants have backups that cannot be restored today?");
  });

  it("keeps showing the page across tenants while the session is under All tenants, whatever the address", async () => {
    const page = await open(mixed(), { canViewAllTenants: true, scope: "all" });
    expect(page.querySelector('[data-slot="verify-all-tenants"]')).not.toBeNull();
  });

  it("ignores scope=all for somebody who may not look across tenants", async () => {
    router.search = { scope: "all" };
    const setScopeAll = vi.fn();
    const page = await open(mixed(), { canViewAllTenants: false, setScopeAll });
    expect(setScopeAll).not.toHaveBeenCalled();
    expect(page.querySelector('[data-slot="verify-all-tenants"]')).toBeNull();
    expect(page.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it("keeps the scope in the address when a chip is chosen under All tenants", async () => {
    const page = await open(mixed(), { canViewAllTenants: true, scope: "all" });
    expect(page.querySelector('[data-slot="state-chips"]')).toBeNull(); // the slot is empty without the extension
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
