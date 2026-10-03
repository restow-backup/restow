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
    expect(text(operation)).toContain("Adding the share nas2");
    expect(text(operation)).toContain("Failed, nothing was changed");
    expect(text(slot("mounts-failure"))).toContain("not writable");
    expect(text(slot("mounts-failure"))).toContain("Permission denied");
  });

  it("checks a new share before it sends it, then sends it", async () => {
    const { mock, requests } = routes({ "POST /mounts": () => json(view(), 202) });
    vi.stubGlobal("fetch", mock);
    await open();
    await click(buttonByText(document.body, "Add share"));
    await flush(4);
    const dialog = slot("mounts-add-dialog");
    expect(dialog).not.toBeNull();
    await type(document.body.querySelector("#mount-name"), "backup");
    await type(document.body.querySelector("#mount-server"), "nas,nolock");
    await type(document.body.querySelector("#mount-export"), "/volume1/backup");
    await click(buttonByText(dialog as HTMLElement, "Add share"));
    await flush(4);
    expect(text(dialog)).toContain("without commas, spaces or");
    expect(requests.filter((request) => request.method === "POST")).toEqual([]);

    await type(document.body.querySelector("#mount-server"), "nas.example.lan");
    await click(buttonByText(dialog as HTMLElement, "Add share"));
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
    await click(buttonByText(document.body, "Remove share"));
    await flush(8);
    expect(text(slot("mounts-users"))).toContain("Contoso: NAS");
    expect(text(slot("mounts-users"))).toContain("/mnt/restow/nas/contoso");
  });

  it("closes every change to everyone but the owner", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open({ session: providerSession("administrator") });
    expect(text(slot("access-note"))).toContain("needs the Owner role");
    expect(buttonByText(document.body, "Add share")?.disabled).toBe(true);
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
});
