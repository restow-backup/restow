// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type Mounted,
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

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
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

async function open(data: ReadinessOverview): Promise<HTMLElement> {
  const { mock } = routedFetch({ "GET /verify/latest": () => json(data) });
  vi.stubGlobal("fetch", mock);
  mounted = mount(<VerifyPage />, {
    session: sessionAs({
      activeTenant: {
        id: "t1",
        name: "Contoso",
        slug: "contoso",
        role: "tenant_admin",
        status: "active",
      },
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
    expect(content).toContain("All (3)");
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
    expect(content).toContain("All (2)");
  });

  it("is still consistent for a server that sends no machines", async () => {
    const data = overview([mailbox("Ada")], []);
    const { endpoints: _omitted, ...withoutEndpoints } = data;
    const page = await open(withoutEndpoints as ReadinessOverview);
    expect(text(page)).toContain("All (1)");
  });
});
