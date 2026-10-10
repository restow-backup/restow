// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Mounted,
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  json,
  problem,
  routedFetch,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { resetWebExtensionsForTesting } from "@/lib/extensions";

import {
  mounterStarting,
  mountsErrorKey,
  validExportPath,
  validMountName,
  validNfsServer,
} from "./sections/mounts-api";
import { operationPercent } from "./sections/mounts-section";
import { DEFAULT_STORAGE, SETTINGS, openInstallation, providerSession } from "./testing";

/**
 * Installation > Mounts in a DOM: what it says when the mounter is not running, the
 * shares and the last operation, adding a share (checked before it is sent), the
 * refused removal of a share a storage location uses, and the read-only state for
 * everyone but the owner.
 */

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

const SHARE = {
  protocol: "nfs",
  name: "nas",
  server: "10.0.0.5",
  export: "/volume1/backup",
  nfsVersion: "4.1",
  readOnly: false,
};

const CAPABILITIES = {
  ready: true,
  blockers: [],
  runner: "helper",
  composeFile: "docker-compose.yml",
  overrideFile: "docker-compose.override.yml",
  protocols: ["nfs"],
  checkedAt: "2026-10-02T10:00:00.000Z",
};

const steps = (statuses: string[]) =>
  ["validate", "probe", "write", "apply", "health", "cleanup"].map((id, index) => ({
    id,
    status: statuses[index] ?? "pending",
    startedAt: null,
    finishedAt: null,
  }));

function view(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    unavailableReason: null,
    demo: false,
    enableCommand: "docker compose --profile mounts up -d mounter",
    mountRoot: "/mnt/restow",
    state: {
      mounterVersion: "0.3.0",
      mounts: [{ mount: SHARE, path: "/mnt/restow/nas", volume: "restow-nfs-nas-12345678" }],
      operation: null,
      history: [],
      capabilities: CAPABILITIES,
      serverTime: "2026-10-02T10:00:00.000Z",
    },
    ...overrides,
  };
}

function routes(overrides: Record<string, () => Response> = {}) {
  return routedFetch({
    "GET /settings": () => json(SETTINGS),
    "GET /mounts": () => json(view()),
    "GET /file-shares/installation-settings": () =>
      json({
        settings: {
          maxConcurrentRunners: 2,
          runnerMemoryMiB: 2048,
          goMemLimitPercent: 80,
          maxRunHours: 72,
          defaultReadConcurrency: 4,
          tenantsMayUsePrivateNetworks: false,
          defaultShareQuotaGib: 0,
          tenantShareQuotaGib: 0,
          tenantShareQuotaGibByTenant: {},
          catalog: { enabled: true, maxEntriesPerShare: 20000000 },
        },
        runner: { available: true, ready: true, blockers: [], running: 0, limit: 8 },
        enableCommand: "docker compose --profile mounts up -d mounter",
      }),
    ...overrides,
  });
}

function text(scope: ParentNode | null | undefined = document.body): string {
  return (scope?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function slot(name: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-slot="${name}"]`);
}

async function open(options: Parameters<typeof openInstallation>[1] = {}) {
  mounted = await openInstallation("/installation/mounts", options);
  await flush(8);
}

describe("Mounts", () => {
  it("says how to start the mounter when it does not run", async () => {
    const down = view({ available: false, unavailableReason: "unreachable", state: null });
    vi.stubGlobal("fetch", routes({ "GET /mounts": () => json(down) }).mock);
    await open();
    const card = slot("mounts-unavailable");
    expect(text(card)).toContain("The mounter is not running");
    expect(text(card)).toContain("docker compose --profile mounts up -d mounter");
    expect(text(card)).toContain("Docker socket");
    expect(slot("mounts-list")).toBeNull();
  });

  it("offers Enable network shares to the owner when the updater can start the mounter", async () => {
    const enable = {
      running: false,
      via: "updater",
      command: "docker compose --profile mounts up -d mounter",
      disableCommand: "docker compose --profile mounts stop mounter",
      lastAttempt: null,
    };
    const down = view({ available: false, unavailableReason: "unreachable", state: null, enable });
    const started = view({ enable: { ...enable, running: true, via: null } });
    let current = down;
    const { mock, requests } = routes({
      "GET /mounts": () => json(current),
      "POST /mounts/enable": () => {
        current = started;
        return json(started);
      },
    });
    vi.stubGlobal("fetch", mock);
    await open();
    const card = slot("mounts-unavailable");
    expect(text(card)).toContain("The updater can start the mounter for you");
    expect(text(card)).toContain("Or run this command on the host");
    expect(text(card)).toContain("docker compose --profile mounts stop mounter");
    const button = buttonByText(card as HTMLElement, "Enable network shares");
    expect(button).not.toBeNull();
    await click(button as HTMLElement);
    await flush(8);
    expect(
      requests.some((request) => request.method === "POST" && request.path === "/mounts/enable"),
    ).toBe(true);
    expect(slot("mounts-unavailable")).toBeNull();
    expect(slot("mounts-list")).not.toBeNull();
  });

  it("shows why the updater could not start the mounter", async () => {
    const down = view({
      available: false,
      unavailableReason: "unreachable",
      state: null,
      enable: {
        running: false,
        via: "updater",
        command: "docker compose --profile mounts up -d mounter",
        disableCommand: "docker compose --profile mounts stop mounter",
        lastAttempt: {
          status: "failed",
          reason: "compose_unsupported",
          image: null,
          requestedAt: "2026-10-02T09:00:00.000Z",
          finishedAt: "2026-10-02T09:00:02.000Z",
          detail: "resolves to nothing",
        },
      },
    });
    vi.stubGlobal("fetch", routes({ "GET /mounts": () => json(down) }).mock);
    await open();
    const failed = slot("enable-mounter-failed");
    expect(text(failed)).toContain("could not start the mounter");
    expect(text(failed)).toContain("RESTOW_MOUNTER_IMAGE");
    expect(text(failed)).toContain("resolves to nothing");
  });

  it("shows only the command without an updater, and no button to other roles", async () => {
    const command = {
      running: false,
      via: "command",
      command: "docker compose --profile mounts up -d mounter",
      disableCommand: "docker compose --profile mounts stop mounter",
      lastAttempt: null,
    };
    let down = view({
      available: false,
      unavailableReason: "unreachable",
      state: null,
      enable: command,
    });
    vi.stubGlobal("fetch", routes({ "GET /mounts": () => json(down) }).mock);
    await open();
    expect(slot("enable-mounter")).toBeNull();
    expect(text(slot("mounts-unavailable"))).toContain(
      "docker compose --profile mounts up -d mounter",
    );
    await mounted?.unmount();
    down = view({
      available: false,
      unavailableReason: "unreachable",
      state: null,
      enable: { ...command, via: "updater" },
    });
    vi.stubGlobal("fetch", routes({ "GET /mounts": () => json(down) }).mock);
    await open({ session: providerSession("administrator") });
    expect(slot("enable-mounter")).toBeNull();
  });

  it("lists the shares with their path in the application", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open();
    const share = document.body.querySelector('[data-slot="mounts-share"][data-name="nas"]');
    expect(text(share)).toContain("10.0.0.5:/volume1/backup");
    expect(text(share)).toContain("/mnt/restow/nas");
    expect(text(share)).toContain("NFS 4.1");
    expect(text()).toContain("/mnt/restow/<name>");
  });

  it("shows the last operation with its steps and why it failed", async () => {
    const failed = view();
    (failed.state as Record<string, unknown>).operation = {
      id: "op-1",
      kind: "add",
      name: "nas2",
      mount: null,
      status: "failed",
      steps: steps(["done", "failed", "skipped", "skipped", "skipped", "skipped"]),
      failure: { code: "probe.not_writable", step: "probe", detail: "Permission denied" },
      warnings: [],
      requestedBy: { userId: "u1", label: "owner@example.test", ip: null },
      startedAt: "2026-10-02T09:59:00.000Z",
      finishedAt: "2026-10-02T10:00:00.000Z",
    };
    vi.stubGlobal("fetch", routes({ "GET /mounts": () => json(failed) }).mock);
    await open();
    const operation = slot("mounts-operation");
    expect(text(operation)).toContain("Adding the network share nas2");
    expect(text(operation)).toContain("Failed, nothing was changed");
    expect(text(slot("mounts-failure"))).toContain("not writable");
    expect(text(slot("mounts-failure"))).toContain("Permission denied");
  });

  it("checks a new share before it sends it, then sends it", async () => {
    const { mock, requests } = routes({ "POST /mounts": () => json(view(), 202) });
    vi.stubGlobal("fetch", mock);
    await open();
    await click(buttonByText(document.body, "Add network share"));
    await flush(4);
    const dialog = slot("mounts-add-dialog");
    expect(dialog).not.toBeNull();
    await type(document.body.querySelector("#mount-name"), "backup");
    await type(document.body.querySelector("#mount-server"), "nas,nolock");
    await type(document.body.querySelector("#mount-export"), "/volume1/backup");
    await click(buttonByText(dialog as HTMLElement, "Add network share"));
    await flush(4);
    expect(text(dialog)).toContain("without commas, spaces or");
    expect(requests.filter((request) => request.method === "POST")).toEqual([]);

    await type(document.body.querySelector("#mount-server"), "nas.example.lan");
    await click(buttonByText(dialog as HTMLElement, "Add network share"));
    await flush(8);
    expect(requests.filter((request) => request.method === "POST")).toEqual([
      {
        method: "POST",
        path: "/mounts",
        body: {
          mount: {
            protocol: "nfs",
            name: "backup",
            server: "nas.example.lan",
            export: "/volume1/backup",
            nfsVersion: "4.1",
            readOnly: false,
          },
        },
      },
    ]);
  });

  it("names the storage locations that keep a share from being removed", async () => {
    const users = [
      {
        kind: "target",
        tenantId: "t1",
        tenantName: "Contoso",
        name: "NAS",
        path: "/mnt/restow/nas/contoso",
      },
    ];
    const { mock } = routes({
      "DELETE /mounts/nas": () => problem("urn:restow:problem:mount-in-use", 409, { users }),
    });
    vi.stubGlobal("fetch", mock);
    await open();
    await click(buttonByText(document.body, "Remove"));
    await flush(4);
    await click(buttonByText(document.body, "Remove network share"));
    await flush(8);
    expect(text(slot("mounts-users"))).toContain("Contoso: NAS");
    expect(text(slot("mounts-users"))).toContain("/mnt/restow/nas/contoso");
  });

  it("shows a share that waits for running jobs, and its failure", async () => {
    const pending = {
      mount: { ...SHARE, name: "nas2" },
      requestedBy: { userId: "u1", label: "owner@example.test", ip: null },
      requestedAt: "2026-10-02T09:59:00.000Z",
      failure: null,
    };
    vi.stubGlobal("fetch", routes({ "GET /mounts": () => json(view({ pending })) }).mock);
    await open();
    expect(text(slot("mounts-pending"))).toContain("The network share nas2 waits for running jobs");
    expect(buttonByText(slot("mounts-pending") as HTMLElement, "Cancel")).not.toBeNull();
    await mounted?.unmount();
    const failed = { ...pending, failure: { code: "limit", detail: "20 shares" } };
    vi.stubGlobal("fetch", routes({ "GET /mounts": () => json(view({ pending: failed })) }).mock);
    await open();
    expect(text(slot("mounts-pending"))).toContain("maximum number of network shares");
    expect(buttonByText(slot("mounts-pending") as HTMLElement, "Dismiss")).not.toBeNull();
  });

  it("closes every change to everyone but the owner", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open({ session: providerSession("administrator") });
    expect(text(slot("access-note"))).toContain("needs the Owner role");
    expect(buttonByText(document.body, "Add network share")?.disabled).toBe(true);
    expect(buttonByText(document.body, "Remove")?.disabled).toBe(true);
  });
});

describe("the paths of the shares in a storage form", () => {
  it("offers them under the path field of a directory, one click fills it", async () => {
    const { mock } = routes({
      "GET /settings/default-storage": () => json(DEFAULT_STORAGE),
      "GET /mounts/paths": () => json({ paths: ["/mnt/restow/nas"] }),
    });
    vi.stubGlobal("fetch", mock);
    mounted = await openInstallation("/installation/default-storage", {});
    await flush(8);
    const hints = slot("mount-path-hints");
    expect(text(hints)).toContain("Mounted network shares");
    await click(buttonByText(hints as HTMLElement, "Use /mnt/restow/nas"));
    await flush(2);
    expect(document.body.querySelector<HTMLInputElement>("#target-base-path")?.value).toBe(
      "/mnt/restow/nas",
    );
  });

  it("offers nothing without shares", async () => {
    vi.stubGlobal(
      "fetch",
      routes({
        "GET /settings/default-storage": () => json(DEFAULT_STORAGE),
        "GET /mounts/paths": () => json({ paths: [] }),
      }).mock,
    );
    mounted = await openInstallation("/installation/default-storage", {});
    await flush(8);
    expect(slot("mount-path-hints")).toBeNull();
  });
});

describe("mounts helpers", () => {
  it("check names, servers and export paths like the server", () => {
    expect(validMountName("nas-01")).toBe(true);
    expect(validMountName("-nas")).toBe(false);
    expect(validMountName("NAS")).toBe(false);
    expect(validNfsServer("nas.example.lan")).toBe(true);
    expect(validNfsServer("192.168.1.10")).toBe(true);
    expect(validNfsServer("[fd00::1]")).toBe(true);
    expect(validNfsServer("fd00::1")).toBe(true);
    expect(validNfsServer("300.1.1.1")).toBe(false);
    expect(validNfsServer("nas,ro")).toBe(false);
    expect(validNfsServer("nas name")).toBe(false);
    expect(validExportPath("/volume1/backup")).toBe(true);
    expect(validExportPath("volume1")).toBe(false);
    expect(validExportPath("/a/../b")).toBe(false);
    expect(validExportPath("/a,ro")).toBe(false);
  });

  it("weighs the progress of a running operation", () => {
    const running = {
      status: "running",
      steps: steps(["done", "done", "running"]),
    } as unknown as Parameters<typeof operationPercent>[0];
    expect(operationPercent(running)).toBe(30);
  });

  it("maps errors to messages", () => {
    expect(mountsErrorKey(new Error("x"))).toBe("installation:mounts.errors.generic");
  });

  it("follows a start of the mounter for two minutes at most", () => {
    const now = Date.parse("2026-10-02T10:00:00.000Z");
    const attempt = (status: string, finishedAt: string | null) =>
      ({
        available: false,
        demo: false,
        enable: {
          via: "updater",
          lastAttempt: { status, requestedAt: "2026-10-02T09:59:00.000Z", finishedAt },
        },
      }) as unknown as Parameters<typeof mounterStarting>[0];
    expect(mounterStarting(attempt("running", null), now)).toBe(true);
    expect(mounterStarting(attempt("started", "2026-10-02T09:59:30.000Z"), now)).toBe(true);
    expect(mounterStarting(attempt("started", "2026-10-02T09:57:00.000Z"), now)).toBe(false);
    expect(mounterStarting(attempt("failed", "2026-10-02T09:59:30.000Z"), now)).toBe(false);
    expect(mounterStarting(undefined, now)).toBe(false);
  });
});
