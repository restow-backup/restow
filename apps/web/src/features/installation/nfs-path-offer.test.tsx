// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Mounted,
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  json,
  routedFetch,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { resetWebExtensionsForTesting } from "@/lib/extensions";

import { DEFAULT_STORAGE, SETTINGS, openInstallation, providerSession } from "./testing";

/**
 * The NFS shortcut of the storage form (docs/MOUNTS.md, "From the storage form"), in a
 * DOM, on the path field of the installation default storage (the same fields as a
 * tenant's storage location): an NFS address typed into the field is recognised, the
 * share can be tested and mounted, and once the mounter reports it mounted the field
 * holds its path. A share that is mounted already is offered as it is; an add while jobs
 * run waits and can be cancelled; everyone but the owner is told whom to ask; without the
 * mounter the command that starts it is shown.
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
  vi.useRealTimers();
  document.body.innerHTML = "";
  await i18n.changeLanguage("en");
});

const CAPABILITIES = {
  ready: true,
  blockers: [],
  runner: "helper",
  composeFile: "docker-compose.yml",
  overrideFile: "docker-compose.override.yml",
  protocols: ["nfs"],
  checkedAt: "2026-10-10T10:00:00.000Z",
};

const SPEC = {
  protocol: "nfs",
  name: "nas-restow",
  server: "nas.local",
  export: "/volume1/restow",
  nfsVersion: "4.1",
  readOnly: false,
};

function operation(status: string) {
  const done = status === "succeeded";
  return {
    id: "op-2",
    kind: "add",
    name: "nas-restow",
    mount: SPEC,
    status,
    steps: ["validate", "probe", "write", "apply", "health", "cleanup"].map((id, index) => ({
      id,
      status: done || index < 2 ? "done" : index === 2 ? "running" : "pending",
      startedAt: null,
      finishedAt: null,
    })),
    failure: null,
    warnings: [],
    requestedBy: { userId: "u1", label: "owner@example.test", ip: null },
    startedAt: "2026-10-10T10:00:00.000Z",
    finishedAt: done ? "2026-10-10T10:01:00.000Z" : null,
  };
}

function view(overrides: { mounts?: unknown[]; operation?: unknown; pending?: unknown } = {}) {
  return {
    available: true,
    unavailableReason: null,
    demo: false,
    enableCommand: "docker compose --profile mounts up -d mounter",
    mountRoot: "/mnt/restow",
    state: {
      mounterVersion: "0.3.3",
      mounts: overrides.mounts ?? [],
      operation: overrides.operation ?? null,
      history: [],
      capabilities: CAPABILITIES,
      serverTime: "2026-10-10T10:00:00.000Z",
    },
    pending: overrides.pending ?? null,
  };
}

function routes(overrides: Record<string, () => Response> = {}) {
  return routedFetch({
    "GET /settings": () => json(SETTINGS),
    "GET /settings/default-storage": () => json(DEFAULT_STORAGE),
    "GET /mounts/paths": () => json({ paths: [] }),
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

function pathField(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>("#target-base-path");
  if (!input) {
    throw new Error("no path field");
  }
  return input;
}

async function open(options: Parameters<typeof openInstallation>[1] = {}) {
  mounted = await openInstallation("/installation/default-storage", options);
  await flush(8);
}

async function enter(value: string) {
  await type(pathField(), value);
  await flush(8);
}

describe("an NFS address in the path field", () => {
  it("is recognised; a local or a Windows path is not", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await open();
    await enter("/data/chunks");
    expect(slot("nfs-offer")).toBeNull();
    await enter("C:\\backup");
    expect(slot("nfs-offer")).toBeNull();
    await enter("nfs://nas.local/volume1/restow");
    expect(text(slot("nfs-offer"))).toContain("This is the address of an NFS network share");
    expect(text(slot("nfs-offer"))).toContain("nas.local:/volume1/restow");
    expect(buttonByText(document.body, "Mount as NFS network share")).not.toBeNull();
  });

  it("tests the share, mounts it and fills in its path", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let current = view();
    const { mock, requests } = routes({
      "GET /mounts": () => json(current),
      "POST /mounts/test": () =>
        json({ ok: true, code: null, detail: null, wrote: true, durationMs: 40 }),
      "POST /mounts": () => {
        current = view({ operation: operation("running") });
        return json(current, 202);
      },
    });
    vi.stubGlobal("fetch", mock);
    await open();
    await enter("nas.local:/volume1/restow");
    await click(buttonByText(document.body, "Mount as NFS network share"));
    await flush(4);
    const form = slot("nfs-offer-form") as HTMLElement;
    expect(document.body.querySelector<HTMLInputElement>("#nfs-offer-name")?.value).toBe(
      "nas-restow",
    );
    expect(text(slot("nfs-offer-restart"))).toContain(
      "restarts its api and worker once (a few seconds); the page reconnects by itself",
    );

    await click(buttonByText(form, "Test connection"));
    await flush(8);
    expect(requests.find((request) => request.path === "/mounts/test")?.body).toEqual({
      mount: SPEC,
    });
    expect(text(slot("mounts-test"))).toContain("reachable and writable");

    await type(document.body.querySelector("#nfs-offer-subfolder"), "tenant-a");
    await click(buttonByText(form, "Mount and use"));
    await flush(8);
    expect(
      requests.find((request) => request.method === "POST" && request.path === "/mounts"),
    ).toMatchObject({ body: { mount: SPEC, whenIdle: true } });
    expect(text(slot("nfs-offer-progress"))).toContain("Adding the network share nas-restow");
    expect(pathField().value).toBe("nas.local:/volume1/restow");

    current = view({
      operation: operation("succeeded"),
      mounts: [{ mount: SPEC, path: "/mnt/restow/nas-restow", volume: "restow-nfs-nas-restow-1" }],
    });
    await vi.advanceTimersByTimeAsync(3_100);
    await flush(8);
    expect(pathField().value).toBe("/mnt/restow/nas-restow/tenant-a");
    expect(text(slot("nfs-offer-done"))).toContain("nas-restow is mounted");
    expect(slot("nfs-offer")).toBeNull();
  });

  it("waits for running jobs and lets the owner cancel", async () => {
    const pending = {
      mount: SPEC,
      requestedBy: { userId: "u1", label: "owner@example.test", ip: null },
      requestedAt: "2026-10-10T10:00:00.000Z",
      failure: null,
    };
    let current = view();
    const { mock, requests } = routes({
      "GET /mounts": () => json(current),
      "POST /mounts": () => {
        current = view({ pending });
        return json(current, 202);
      },
      "DELETE /mounts/nas-restow": () => {
        current = view();
        return json(current);
      },
    });
    vi.stubGlobal("fetch", mock);
    await open();
    await enter("nas.local:/volume1/restow");
    await click(buttonByText(document.body, "Mount as NFS network share"));
    await flush(4);
    await click(buttonByText(slot("nfs-offer-form") as HTMLElement, "Mount and use"));
    await flush(8);
    const waiting = slot("nfs-offer-waiting");
    expect(text(waiting)).toContain("Waiting for running jobs to finish");
    expect(text(waiting)).toContain("as soon as they have finished");
    await click(buttonByText(waiting as HTMLElement, "Cancel"));
    await flush(8);
    expect(
      requests.some(
        (request) => request.method === "DELETE" && request.path === "/mounts/nas-restow",
      ),
    ).toBe(true);
    expect(slot("nfs-offer-waiting")).toBeNull();
    expect(buttonByText(document.body, "Mount as NFS network share")).not.toBeNull();
  });

  it("offers a share that is mounted already instead of mounting it again", async () => {
    const existing = { ...SPEC, name: "nas", export: "/volume1" };
    const { mock, requests } = routes({
      "GET /mounts": () =>
        json(view({ mounts: [{ mount: existing, path: "/mnt/restow/nas", volume: "v" }] })),
    });
    vi.stubGlobal("fetch", mock);
    await open();
    await enter("nas.local:/volume1/restow");
    expect(text(slot("nfs-offer-existing"))).toContain("mounted already as nas");
    expect(buttonByText(document.body, "Mount as NFS network share")).toBeNull();
    await click(
      buttonByText(slot("nfs-offer-existing") as HTMLElement, "Use /mnt/restow/nas/restow"),
    );
    await flush(4);
    expect(pathField().value).toBe("/mnt/restow/nas/restow");
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("shows the command that starts the mounter when it does not run", async () => {
    const down = { ...view(), available: false, unavailableReason: "unreachable", state: null };
    vi.stubGlobal("fetch", routes({ "GET /mounts": () => json(down) }).mock);
    await open();
    await enter("192.168.1.10:/export/backup");
    const card = slot("mounts-unavailable");
    expect(text(card)).toContain("The mounter is not running");
    expect(text(card)).toContain("docker compose --profile mounts up -d mounter");
    expect(buttonByText(document.body, "Mount as NFS network share")).toBeNull();
  });

  it("tells everyone but the owner whom to ask, in English and in German", async () => {
    const { mock, requests } = routes();
    vi.stubGlobal("fetch", mock);
    await open({ session: providerSession("administrator") });
    await enter("192.168.1.10:/export/backup");
    const note = text(slot("nfs-offer-ask-owner"));
    expect(note).toContain("Ask the provider owner to mount this network share");
    expect(note).toContain("192.168.1.10");
    expect(note).toContain("/export/backup");
    expect(buttonByText(document.body, "Mount as NFS network share")).toBeNull();

    await i18n.changeLanguage("de");
    await flush(4);
    expect(text(slot("nfs-offer"))).toContain("Das ist die Adresse eines NFS-Netzlaufwerks");
    expect(text(slot("nfs-offer-ask-owner"))).toContain("Bitten Sie den Provider-Inhaber");
    expect(requests.some((request) => request.method !== "GET")).toBe(false);
  });

  it("offers the owner the shortcut in German", async () => {
    vi.stubGlobal("fetch", routes().mock);
    await i18n.changeLanguage("de");
    await open();
    await enter("nas.local:/volume1/restow");
    await click(buttonByText(document.body, "Als NFS-Netzlaufwerk einbinden"));
    await flush(4);
    expect(text(slot("nfs-offer-restart"))).toContain(
      "startet API und Worker einmal neu (wenige Sekunden); die Seite verbindet sich von selbst wieder",
    );
    expect(buttonByText(document.body, "Einbinden und verwenden")).not.toBeNull();
  });
});
