// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  json,
  type Mounted,
  problem,
  routedFetch,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { resetWebExtensionsForTesting } from "@/lib/extensions";
import type { ClusterView } from "./cluster-api";
import { openInstallation, providerSession, SETTINGS } from "./testing";

/**
 * Installation > Cluster in a DOM: only the owner sees and does anything (the others the note
 * that it is the owner's, and no request); the nodes with their processes and releases; what a
 * node needs; a join token is shown once with the command for the new host; a token that needs a
 * recent sign-in asks to confirm it is you; removing a node asks first and sends the removal.
 */

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    passkey: { listUserPasskeys: async () => ({ data: [], error: null }) },
    signIn: { passkey: async () => ({ error: null }) },
  },
  browserSupportsPasskeys: () => false,
  needsSecondFactor: () => false,
}));

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetWebExtensionsForTesting();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const NODE = "0b8c8e5e-6d6a-4f7e-9d3c-1f2e3d4c5b6a";

const VIEW: ClusterView = {
  version: "0.5.0",
  nodes: [
    {
      id: null,
      name: "main",
      hostname: null,
      address: null,
      status: "main",
      joinedAt: null,
      version: "0.5.0",
      outdated: false,
      versionMismatch: false,
      processes: [
        {
          role: "worker",
          instanceId: "worker-a",
          version: "0.5.0",
          alive: true,
          state: "running",
          beatAt: "2026-11-05T09:00:00.000Z",
          startedAt: "2026-11-05T08:00:00.000Z",
        },
      ],
    },
    {
      id: NODE,
      name: "worker-1",
      hostname: "worker-1.example.com",
      address: "198.51.100.20",
      status: "active",
      joinedAt: "2026-11-05T08:30:00.000Z",
      version: "0.4.12",
      outdated: true,
      versionMismatch: true,
      processes: [
        {
          role: "worker",
          instanceId: "worker-b",
          version: "0.4.12",
          alive: true,
          state: "version_mismatch",
          beatAt: "2026-11-05T09:00:00.000Z",
          startedAt: "2026-11-05T08:30:00.000Z",
        },
      ],
    },
  ],
  tokens: [],
  targets: [
    { tenantId: "t-1", tenantName: "Contoso", targetId: "s1", kind: "s3", path: null },
    {
      tenantId: null,
      tenantName: null,
      targetId: "default",
      kind: "directory",
      path: "/srv/backups",
    },
  ],
  joinBlocked: false,
  database: {
    address: "10.0.0.5:5432",
    ssl: true,
    nodeRules: [{ type: "hostssl", address: "198.51.100.20", method: "scram-sha-256" }],
    error: null,
  },
};

function text(scope: ParentNode | null | undefined = document.body): string {
  return (scope?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("Installation > Cluster", () => {
  it("is the owner's: an administrator gets the note and no request", async () => {
    const routes = routedFetch({ "GET /settings": () => json(SETTINGS) });
    vi.stubGlobal("fetch", routes.mock);
    mounted = await openInstallation("/installation/cluster", {
      session: providerSession("administrator"),
    });
    await flush(8);
    expect(document.querySelector('[data-slot="access-note"]')).not.toBeNull();
    expect(routes.requests.some((request) => request.path === "/cluster")).toBe(false);
    expect(document.querySelector("#cluster-node-name")).toBeNull();
  });

  it("shows the nodes, what a node needs, and the note on replication", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({ "GET /settings": () => json(SETTINGS), "GET /cluster": () => json(VIEW) }).mock,
    );
    mounted = await openInstallation("/installation/cluster", {
      session: providerSession("owner"),
    });
    await flush(8);
    const nodes = text(document.querySelector('[data-testid="cluster-nodes"]'));
    expect(nodes).toContain("This host (main)");
    expect(nodes).toContain("worker-1");
    expect(nodes).toContain("other release");
    expect(nodes).toContain("waits for an update");
    expect(nodes).toContain("sudo bash install.sh --update-worker");
    const targets = text(document.querySelector('[data-testid="cluster-targets"]'));
    expect(targets).toContain("S3: reachable from any host");
    expect(targets).toContain("/srv/backups: directory: must exist at the same path");
    expect(text()).toContain("Reachable for worker nodes at 10.0.0.5:5432 (TLS on)");
    expect(text()).toContain("Real replication is in development");
    expect(text()).toContain("The master key cannot be rotated yet");
  });

  it("shows a join token once, with the command for the new host", async () => {
    const routes = routedFetch({
      "GET /settings": () => json(SETTINGS),
      "GET /cluster": () => json(VIEW),
      "POST /cluster/join-tokens": () =>
        json(
          {
            id: "tok-1",
            token: "rsj_abcdefghijABCDEFGHIJ0123456789abcdefghij",
            prefix: "rsj_abcdefgh",
            expiresAt: "2026-11-05T10:00:00.000Z",
          },
          201,
        ),
    });
    vi.stubGlobal("fetch", routes.mock);
    mounted = await openInstallation("/installation/cluster", {
      session: providerSession("owner"),
    });
    await flush(8);
    expect(buttonByText(document.body, "Issue join token")?.disabled).toBe(true);
    await type(document.querySelector("#cluster-node-name"), "worker-2");
    await type(document.querySelector("#cluster-node-address"), "198.51.100.21");
    await click(buttonByText(document.body, "Issue join token"));
    await flush(8);
    const issued = routes.requests.find((request) => request.method === "POST");
    expect(issued?.body).toEqual({
      nodeName: "worker-2",
      ttlMinutes: 60,
      standbyScheduler: false,
      expectedAddress: "198.51.100.21",
    });
    const once = text(document.querySelector('[data-testid="cluster-token-once"]'));
    expect(once).toContain("It is shown only now and works once");
    expect(once).toContain(
      `sudo bash install.sh --join ${window.location.origin} --join-token rsj_abcdefghijABCDEFGHIJ0123456789abcdefghij --node-name worker-2`,
    );
    await click(buttonByText(document.body, "Hide"));
    expect(text()).not.toContain("rsj_abcdefghijABCDEFGHIJ0123456789abcdefghij");
  });

  it("asks to confirm it is you when the token needs a recent sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /settings": () => json(SETTINGS),
        "GET /cluster": () => json(VIEW),
        "POST /cluster/join-tokens": () =>
          problem("urn:restow:problem:recent-sign-in-required", 403, { maxAgeSeconds: 600 }),
      }).mock,
    );
    mounted = await openInstallation("/installation/cluster", {
      session: providerSession("owner"),
    });
    await flush(8);
    await type(document.querySelector("#cluster-node-name"), "worker-2");
    await click(buttonByText(document.body, "Issue join token"));
    await flush(8);
    expect(text()).toContain("Confirm it is you");
    expect(text()).toContain("needs a sign-in from the last 10 minutes");
    expect(document.querySelector('[data-testid="cluster-token-once"]')).toBeNull();
  });

  it("removes a node after asking", async () => {
    const routes = routedFetch({
      "GET /settings": () => json(SETTINGS),
      "GET /cluster": () => json(VIEW),
      [`DELETE /cluster/nodes/${NODE}`]: () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", routes.mock);
    mounted = await openInstallation("/installation/cluster", {
      session: providerSession("owner"),
    });
    await flush(8);
    await click(buttonByText(document.body, "Remove node"));
    await flush(4);
    expect(text()).toContain("Remove the node worker-1?");
    expect(text()).toContain("cannot be taken back");
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    await click(buttonByText(dialog ?? document.body, "Remove node"));
    await flush(8);
    expect(routes.requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("says why no token can be issued while the database is not reachable", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /settings": () => json(SETTINGS),
        "GET /cluster": () =>
          json({ ...VIEW, database: { address: null, ssl: false, nodeRules: [], error: null } }),
      }).mock,
    );
    mounted = await openInstallation("/installation/cluster", {
      session: providerSession("owner"),
    });
    await flush(8);
    expect(text()).toContain("Not reachable from the network (the default).");
    expect(text()).toContain("sudo bash install.sh --allow-worker");
    expect(document.querySelector<HTMLInputElement>("#cluster-node-name")?.disabled).toBe(true);
  });
});
