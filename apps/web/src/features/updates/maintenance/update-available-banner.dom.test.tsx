// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import type { ProviderRole } from "@/lib/api";
import type { RunningVersion } from "@/lib/session";
import type { MaintenanceView } from "../api";
import {
  click,
  enableActEnvironment,
  installMemoryStorage,
  iso,
  type Mounted,
  maintenanceFixture,
  mount,
  sessionAs,
} from "../testing";
import { MaintenanceBanner } from "./maintenance-banner";
import type { MaintenanceSnapshot } from "./maintenance-state";
import { StaticMaintenanceProvider } from "./use-maintenance";

/**
 * "Restow 0.4.9 is available" (0.5.0): a slim info bar in the slot of the maintenance bar, for the
 * provider team's owner only, closable per version in this browser, below every maintenance
 * bar in priority and never for tenant users.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search: _search,
      children,
      ...props
    }: {
      to: string;
      search?: unknown;
      children: React.ReactNode;
    }) => (
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

beforeEach(() => {
  installMemoryStorage();
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

const version = (latest: string, overrides: Partial<RunningVersion> = {}): RunningVersion => ({
  running: "0.4.8",
  commit: null,
  latest,
  updateAvailable: true,
  releaseUrl: `https://example.test/releases/v${latest}`,
  ...overrides,
});

interface Setup {
  latest?: string;
  version?: RunningVersion | null;
  view?: MaintenanceView;
  tenant?: boolean;
  providerRole?: ProviderRole;
}

async function show(setup: Setup = {}) {
  await mounted?.unmount();
  const view = setup.view ?? maintenanceFixture();
  const snapshot: MaintenanceSnapshot = {
    view,
    apiReachable: true,
    offsetMs: 0,
    offsetSamples: [0],
    receivedAt: Date.now(),
  };
  const session = setup.tenant
    ? sessionAs({
        isProviderAdmin: false,
        role: "tenant_admin",
        providerRole: null,
        version: setup.version === undefined ? version(setup.latest ?? "0.4.9") : setup.version,
      })
    : sessionAs({
        providerRole: setup.providerRole ?? "owner",
        version: setup.version === undefined ? version(setup.latest ?? "0.4.9") : setup.version,
      });
  mounted = mount(
    <StaticMaintenanceProvider
      value={{
        snapshot,
        phase: view.phase,
        sawActiveRun: false,
        dismissedRunId: null,
        dismiss: () => undefined,
      }}
    >
      <MaintenanceBanner />
    </StaticMaintenanceProvider>,
    { session },
  );
  await act(async () => {
    await Promise.resolve();
  });
}

const banner = () => document.body.querySelector<HTMLElement>('[data-slot="maintenance-banner"]');
const available = () =>
  document.body.querySelector<HTMLElement>('[data-variant="update-available"]');
const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("the update-available bar", () => {
  it("names the release and leads to the release notes and to the Updates section", async () => {
    await show();
    const bar = available();
    expect(text(bar)).toContain("Restow 0.4.9 is available.");
    const notes = [...(bar?.querySelectorAll("a") ?? [])].find(
      (link) => link.textContent === "Release notes",
    );
    expect(notes?.getAttribute("href")).toBe("https://example.test/releases/v0.4.9");
    expect(notes?.getAttribute("target")).toBe("_blank");
    expect(notes?.getAttribute("rel")).toContain("noopener");
    const open = [...(bar?.querySelectorAll("a") ?? [])].find(
      (link) => link.textContent === "Go to updates",
    );
    expect(open?.getAttribute("href")).toBe("/installation/updates");
    // Info colour, never green, and nothing that moves.
    expect(bar?.innerHTML).toContain("bg-info/10");
    expect(bar?.innerHTML).not.toMatch(/success|green|emerald|animate-/);
  });

  it("leaves out the release notes link when the release has no address", async () => {
    await show({ version: version("0.4.9", { releaseUrl: null }) });
    expect(text(available())).toContain("Go to updates");
    expect(text(available())).not.toContain("Release notes");
  });

  it("can be closed, for this version only, and the closing is remembered in this browser", async () => {
    await show();
    const close = available()?.querySelector<HTMLButtonElement>("button");
    expect(close?.getAttribute("aria-label")).toBe("Dismiss the notice about version 0.4.9");
    await click(close);
    expect(available()).toBeNull();
    expect(window.localStorage.getItem("restow.update-banner.dismissed.0.4.9")).not.toBeNull();

    // A reload (a new mount) in the same browser: still closed.
    await show();
    expect(available()).toBeNull();

    // A newer release shows the bar again.
    await show({ latest: "0.4.10" });
    expect(text(available())).toContain("Restow 0.4.10 is available.");
    await click(available()?.querySelector("button"));
    expect(available()).toBeNull();
    await show({ latest: "0.4.10" });
    expect(available()).toBeNull();
    // The older closing did not close the newer one, and the newer one does not reopen the older.
    expect(window.localStorage.getItem("restow.update-banner.dismissed.0.4.9")).not.toBeNull();
  });

  it("stays closed for the page load when the browser cannot remember", async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    await show();
    expect(available()).not.toBeNull();
    await click(available()?.querySelector("button"));
    expect(available()).toBeNull();
  });

  it("is hidden while an update is scheduled, running or planned, and when it needs attention", async () => {
    await show({
      view: maintenanceFixture({
        phase: "scheduled",
        runId: "r-1",
        targetVersion: "0.4.9",
        startsAt: iso(300),
      }),
    });
    expect(available()).toBeNull();
    expect(banner()?.getAttribute("data-variant")).toBe("scheduled");

    await show({
      view: maintenanceFixture({ phase: "running", runId: "r-1", targetVersion: "0.4.9" }),
    });
    expect(available()).toBeNull();
    expect(banner()?.getAttribute("data-variant")).toBe("running");

    await show({
      view: maintenanceFixture({
        planned: { version: "0.4.9", startsAt: new Date(Date.now() + 3_600_000).toISOString() },
      }),
    });
    expect(available()).toBeNull();
    expect(banner()?.getAttribute("data-variant")).toBe("planned");

    await show({
      view: maintenanceFixture({
        phase: "failed",
        runId: "r-1",
        outcome: "needs_attention",
        targetVersion: "0.4.9",
      }),
    });
    expect(available()).toBeNull();
    expect(banner()?.getAttribute("data-variant")).toBe("attention");
  });

  it("is back once the maintenance is over", async () => {
    await show({
      view: maintenanceFixture({ phase: "running", runId: "r-1", targetVersion: "0.4.9" }),
    });
    expect(available()).toBeNull();
    await show({ view: maintenanceFixture() });
    expect(available()).not.toBeNull();
  });

  it("is never shown to a tenant user", async () => {
    await show({ tenant: true });
    expect(banner()).toBeNull();
  });

  it("is shown to the owner of the provider team only, who may install the update", async () => {
    await show({ providerRole: "administrator" });
    expect(available()).toBeNull();
    await show({ providerRole: "read_only" });
    expect(available()).toBeNull();
    await show({ providerRole: "owner" });
    expect(available()).not.toBeNull();
  });

  it("is hidden without a newer release", async () => {
    await show({ version: version("0.4.8", { updateAvailable: false }) });
    expect(banner()).toBeNull();
    await show({ version: null });
    expect(banner()).toBeNull();
  });
});
