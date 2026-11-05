// @vitest-environment happy-dom
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  json,
  type Mounted,
  mount,
  routedFetch,
  SESSION,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { resetWebExtensionsForTesting } from "@/lib/extensions";
import {
  endFormReady,
  RESTORE_MODE_PROBLEM,
  type RestoreModeView,
  startFormReady,
} from "./restore-mode-api";
import { RestoreModeBanner } from "./restore-mode-banner";
import { openInstallation, providerSession, SETTINGS } from "./testing";

/**
 * Installation > Restore mode in a DOM: what the page shows while restore mode is on (how it
 * began, the comparison per target, refused deletions, held jobs, key versions and differing
 * keys), the end form that stays closed until what was checked is described and END typed, what
 * it sends, the owner-only end, and the banner provider administrators see on every page.
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

const ACTIVE: RestoreModeView = {
  active: {
    id: "rm-1",
    source: "detected",
    reason: "A storage target shows progress the database does not have.",
    activatedAt: "2026-11-05T09:00:00.000Z",
    activatedBy: { label: "system:worker" },
    holdJobsBefore: "2026-11-05T09:00:00.000Z",
    detection: { tenantId: "t-1", targetId: "target-copy", markerSeq: 120, dbSeq: 80 },
  },
  history: [],
  targets: [
    {
      tenantId: "t-1",
      tenantName: "Contoso",
      targetId: "target-copy",
      outcome: "ahead",
      storageMaxSeq: 120,
      dbSeq: 80,
      unknownKeyVersions: [2],
      detail: null,
      checkedAt: "2026-11-05T09:00:00.000Z",
    },
  ],
  refusals: [
    { pass: "orphan_sweep", tenantId: "t-1", count: 3, lastAt: "2026-11-05T09:30:00.000Z" },
  ],
  heldJobs: { held: 2, waiting: 1 },
  unknownKeyVersions: [{ tenantId: "t-1", targetId: "target-copy", versions: [2] }],
  keyFindings: [
    {
      tenantId: "t-1",
      targetId: "target-primary",
      keyVersion: 2,
      kind: "conflict",
      firstSeenAt: "2026-11-05T09:01:00.000Z",
    },
  ],
};

function text(scope: ParentNode | null | undefined = document.body): string {
  return (scope?.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function typeArea(element: Element | null, value: string): Promise<void> {
  const area = element as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("Installation > Restore mode", () => {
  it("shows how restore mode began and what it found, and ends it with what was checked", async () => {
    const routes = routedFetch({
      "GET /settings": () => json(SETTINGS),
      "GET /restore-mode": () => json(ACTIVE),
      "GET /restore-mode/banner": () =>
        json({ active: true, since: ACTIVE.active?.activatedAt, source: "detected" }),
      "POST /restore-mode/end": () =>
        json({
          ended: true,
          rebase: [],
          acceptedUnreachable: [],
          view: { ...ACTIVE, active: null },
        }),
    });
    vi.stubGlobal("fetch", routes.mock);
    mounted = await openInstallation("/installation/restore-mode", {
      session: providerSession("owner"),
    });
    await flush(8);
    const page = text();
    expect(page).toContain("Restore mode is on");
    expect(page).toContain("Switched on by itself");
    expect(page).toContain("Ahead of the database");
    expect(page).toContain("Orphan sweep: 3 times");
    expect(page).not.toContain("orphan_sweep");
    expect(page).toContain("2 jobs from before the restore were held. 1 more is still queued.");
    expect(page).toContain("versions 2 are in storage but not in the database");
    expect(page).toContain("another valid key is stored under this version");

    const submit = buttonByText(document.body, "End restore mode");
    expect(submit?.disabled).toBe(true);
    await typeArea(document.querySelector("#restore-mode-checked"), "Compared the restore points.");
    await type(document.querySelector("#restore-mode-confirmation"), "END");
    expect(submit?.disabled).toBe(false);
    await click(submit);
    await flush(6);
    const sent = routes.requests.find((request) => request.path === "/restore-mode/end");
    expect(sent?.body).toEqual({
      checked: "Compared the restore points.",
      confirmation: "END",
      storageOnlyData: "keep",
    });
  });

  it("leaves the end to a provider owner", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /settings": () => json(SETTINGS),
        "GET /restore-mode": () => json(ACTIVE),
      }).mock,
    );
    mounted = await openInstallation("/installation/restore-mode", {
      session: providerSession("administrator"),
    });
    await flush(8);
    expect(text()).toContain("Only a provider owner can end restore mode.");
    expect(document.querySelector("#restore-mode-checked")).toBeNull();
  });

  it("words a refused end in the page's language and shows the targets to accept", async () => {
    const unreachableView: RestoreModeView = {
      ...ACTIVE,
      unknownKeyVersions: [],
      targets: ACTIVE.targets.map((target) => ({
        ...target,
        outcome: "unreachable",
        unknownKeyVersions: [],
      })),
    };
    let views = 0;
    const routes = routedFetch({
      "GET /settings": () => json(SETTINGS),
      "GET /restore-mode": () => {
        views++;
        return json(views === 1 ? { ...ACTIVE, unknownKeyVersions: [] } : unreachableView);
      },
      "POST /restore-mode/end": () =>
        json(
          {
            type: RESTORE_MODE_PROBLEM,
            title: "A storage target could not be read",
            status: 409,
            detail:
              "Every storage target must answer before restore mode ends, or be accepted as unreachable.",
            code: "unreachable",
            unreachable: ["t-1/target-copy"],
          },
          409,
        ),
    });
    vi.stubGlobal("fetch", routes.mock);
    await i18n.changeLanguage("de");
    try {
      mounted = await openInstallation("/installation/restore-mode", {
        session: providerSession("owner"),
      });
      await flush(8);
      await typeArea(
        document.querySelector("#restore-mode-checked"),
        "Die Wiederherstellungspunkte verglichen.",
      );
      await type(document.querySelector("#restore-mode-confirmation"), "END");
      await click(buttonByText(document.body, "Wiederherstellungsmodus beenden"));
      await flush(8);
      const page = text();
      expect(page).toContain("Ein Speicherziel konnte nicht gelesen werden.");
      expect(page).not.toContain("Every storage target must answer");
      expect(page).toContain("Als nicht erreichbar akzeptieren: t-1/target-copy");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("lets a provider owner switch it on with a reason", async () => {
    const OFF: RestoreModeView = {
      ...ACTIVE,
      active: null,
      targets: [],
      refusals: [],
      unknownKeyVersions: [],
      keyFindings: [],
    };
    const routes = routedFetch({
      "GET /settings": () => json(SETTINGS),
      "GET /restore-mode": () => json(OFF),
      "GET /restore-mode/banner": () => json({ active: true, since: null, source: "api" }),
      "POST /restore-mode/start": () => json({ id: "rm-2", created: true, view: ACTIVE }),
    });
    vi.stubGlobal("fetch", routes.mock);
    mounted = await openInstallation("/installation/restore-mode", {
      session: providerSession("owner"),
    });
    await flush(8);
    const submit = buttonByText(document.body, "Switch restore mode on");
    expect(submit?.disabled).toBe(true);
    await type(document.querySelector("#restore-mode-reason"), "database dump restored");
    expect(submit?.disabled).toBe(false);
    await click(submit);
    await flush(6);
    expect(routes.requests.find((request) => request.path === "/restore-mode/start")?.body).toEqual(
      { reason: "database dump restored" },
    );
    expect(text()).toContain("Restore mode is on");
  });

  it("offers neither the switch nor a comparison to a read-only member", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /settings": () => json(SETTINGS),
        "GET /restore-mode": () => json({ ...ACTIVE, active: null }),
      }).mock,
    );
    mounted = await openInstallation("/installation/restore-mode", {
      session: providerSession("read_only"),
    });
    await flush(8);
    // The switch is there, closed, with the sentence that says who may use it.
    expect(document.querySelector<HTMLInputElement>("#restore-mode-reason")?.disabled).toBe(true);
    expect(buttonByText(document.body, "Switch restore mode on")?.disabled).toBe(true);
    expect(document.querySelector('[data-slot="access-note"]')).not.toBeNull();
    expect(buttonByText(document.body, "Compare now")?.disabled).toBe(true);
  });

  it("shows the switch closed to an administrator, with the note that it is the owner's", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /settings": () => json(SETTINGS),
        "GET /restore-mode": () => json({ ...ACTIVE, active: null }),
      }).mock,
    );
    mounted = await openInstallation("/installation/restore-mode", {
      session: providerSession("administrator"),
    });
    await flush(8);
    const note = document.querySelector('[data-slot="access-note"]');
    expect(note?.getAttribute("data-reason")).toBe("role");
    expect(document.querySelector<HTMLInputElement>("#restore-mode-reason")?.disabled).toBe(true);
    expect(buttonByText(document.body, "Compare now")?.disabled).toBe(false);
  });

  it("lists what to check before ending it, with the users, address and mail after a restore from a dump", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /settings": () => json(SETTINGS),
        "GET /restore-mode": () => json(ACTIVE),
      }).mock,
    );
    mounted = await openInstallation("/installation/restore-mode", {
      session: providerSession("owner"),
    });
    await flush(8);
    const detected = text(document.querySelector('[data-testid="restore-mode-checklist"]'));
    expect(detected).toContain("Before you end restore mode");
    expect(detected).toContain("Test a restore point of every tenant.");
    expect(detected).not.toContain("Check the notification mail");
    await mounted.unmount();

    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /settings": () => json(SETTINGS),
        "GET /restore-mode": () =>
          json({
            ...ACTIVE,
            active: {
              ...ACTIVE.active,
              source: "setup",
              detection: null,
              activatedBy: {
                label: "setup (restore from restow-20261101-020000-0.4.12-to-0.5.0.dump)",
              },
            },
          }),
      }).mock,
    );
    mounted = await openInstallation("/installation/restore-mode", {
      session: providerSession("owner"),
    });
    await flush(8);
    expect(text()).toContain("Switched on by a restore from a dump (setup wizard or install.sh)");
    const setup = text(document.querySelector('[data-testid="restore-mode-checklist"]'));
    expect(setup).toContain("Check the users and owners");
    expect(setup).toContain("Check the notification mail and send a test message.");
    expect(setup).toContain("point the agents and the nodes to the new one");
  });

  it("needs a reason to switch it on", () => {
    expect(startFormReady("   ")).toBe(false);
    expect(startFormReady("dump restored")).toBe(true);
    expect(startFormReady("x".repeat(501))).toBe(false);
  });

  it("needs at least 20 characters of what was checked and END", () => {
    expect(endFormReady({ checked: "short", confirmation: "END" })).toBe(false);
    expect(endFormReady({ checked: "Compared the restore points.", confirmation: "end" })).toBe(
      false,
    );
    expect(endFormReady({ checked: "Compared the restore points.", confirmation: "END" })).toBe(
      true,
    );
  });
});

async function mountBanner(session: typeof SESSION) {
  const router = createRouter({
    routeTree: createRootRoute({ component: RestoreModeBanner }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return mount(<RouterProvider router={router} />, { session });
}

describe("the restore mode banner", () => {
  it("is shown to provider administrators while restore mode is on, and to nobody else", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /restore-mode/banner": () =>
          json({ active: true, since: "2026-11-05T09:00:00.000Z", source: "cli" }),
      }).mock,
    );
    mounted = await mountBanner(providerSession("read_only"));
    await flush(6);
    expect(text(document.querySelector('[data-slot="restore-mode-banner"]'))).toContain(
      "deletes nothing (no retention, no clean-up, no purge). Backups continue.",
    );
    await mounted.unmount();
    document.body.innerHTML = "";
    mounted = await mountBanner({ ...SESSION, isProviderAdmin: false });
    await flush(4);
    expect(document.querySelector('[data-slot="restore-mode-banner"]')).toBeNull();
  });
});
