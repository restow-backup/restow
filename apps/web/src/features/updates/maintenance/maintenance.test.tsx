// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { ApiError, NetworkError } from "@/lib/api";
import { sessionAs } from "../testing";

import type { MaintenanceView, PublicStatus, StepStatus, UpdateStepId } from "../api";
import { UPDATE_STEPS } from "../api";
import {
  type Mounted,
  NOW,
  buttonByText,
  click,
  enableActEnvironment,
  installMemoryStorage,
  iso,
  maintenanceFixture,
  mount,
} from "../testing";
import { MaintenanceBanner } from "./maintenance-banner";
import { MaintenanceModal } from "./maintenance-modal";
import type { MaintenanceSnapshot, PollDeps } from "./maintenance-state";
import { MaintenanceProvider, StaticMaintenanceProvider } from "./use-maintenance";

/**
 * The maintenance shell in a DOM: the banner and its countdown, the modal and
 * its steps, and the polling through an update that takes the api away.
 */

const toastSpy = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: Object.assign(vi.fn(), toastSpy),
  Toaster: () => null,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      children,
      ...props
    }: { to: string; search?: Record<string, string>; children: React.ReactNode }) => (
      <a
        href={
          search && Object.keys(search).length > 0
            ? `${to}?${new URLSearchParams(search).toString()}`
            : to
        }
        {...props}
      >
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
  for (const spy of Object.values(toastSpy)) {
    spy.mockReset();
  }
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function text(scope: ParentNode = document.body): string {
  return (scope.textContent ?? "").replace(/\s+/g, " ").trim();
}

function modal(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-slot="maintenance-modal"]');
}

function banner(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-slot="maintenance-banner"]');
}

function useFakeTime(clock = NOW) {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(clock);
}

/** Take the mounted shell down (a separate function, so the type of `mounted` is not narrowed by earlier assignments). */
async function unmountShell() {
  await mounted?.unmount();
  mounted = null;
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const restart = () => new NetworkError(new TypeError("Failed to fetch"));
const gateway = (status = 503) => new ApiError(status, null, "Service Unavailable");

/** A controllable pair of sources, and how often each was asked. */
function sources(initial: MaintenanceView | (() => MaintenanceView)) {
  const state = {
    api: (typeof initial === "function" ? initial : () => initial) as () => MaintenanceView | Error,
    edge: (() => null) as () => PublicStatus | null,
    apiCalls: 0,
    edgeCalls: 0,
  };
  const deps: PollDeps = {
    fetchApi: async () => {
      state.apiCalls += 1;
      const result = state.api();
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    fetchEdge: async () => {
      state.edgeCalls += 1;
      return state.edge();
    },
    now: () => Date.now(),
  };
  return { state, deps };
}

function shell(deps: PollDeps, reload = vi.fn()) {
  mounted = mount(
    <MaintenanceProvider deps={deps} reload={reload}>
      <MaintenanceBanner />
      <MaintenanceModal />
    </MaintenanceProvider>,
  );
  return reload;
}

/** The public status the edge serves, from a full view. */
function edgeStatus(view: MaintenanceView): PublicStatus {
  const { runningVersion: _ignored, ...status } = view;
  return status;
}

describe("the banner", () => {
  it("counts down on the server's clock, whatever the browser's clock says", async () => {
    const skew = 3_600_000;
    useFakeTime(NOW - skew);
    const serverNow = () => new Date(Date.now() + skew).toISOString();
    const { deps } = sources(() =>
      maintenanceFixture({
        phase: "scheduled",
        runId: "r-1",
        targetVersion: "0.2.0",
        startsAt: iso(272),
        serverTime: serverNow(),
      }),
    );
    shell(deps);
    await tick(10);

    expect(text(banner() as HTMLElement)).toContain(
      "Maintenance in 04:32: Restow will be updated to version 0.2.0. Save your work.",
    );
    await tick(1100);
    expect(text(banner() as HTMLElement)).toContain("Maintenance in 04:31");
    await tick(60_000);
    expect(text(banner() as HTMLElement)).toContain("Maintenance in 03:31");
  });

  it("ends at zero with a message that the update starts", async () => {
    useFakeTime();
    const { deps } = sources(() =>
      maintenanceFixture({
        phase: "scheduled",
        runId: "r-1",
        targetVersion: "0.2.0",
        startsAt: iso(3),
        serverTime: new Date().toISOString(),
      }),
    );
    shell(deps);
    await tick(10);
    expect(text(banner() as HTMLElement)).toContain("Maintenance in 00:03");
    await tick(3500);
    const bar = text(banner() as HTMLElement);
    expect(bar).toContain("Maintenance is starting: Restow is being updated to version 0.2.0.");
    expect(bar).not.toContain("00:0");
  });

  it("cannot be dismissed while the countdown runs, and shows no modal yet", async () => {
    useFakeTime();
    const { deps } = sources(() =>
      maintenanceFixture({
        phase: "scheduled",
        runId: "r-1",
        targetVersion: "0.2.0",
        startsAt: iso(300),
        serverTime: new Date().toISOString(),
      }),
    );
    shell(deps);
    await tick(10);
    expect(banner()?.querySelectorAll("button")).toHaveLength(0);
    expect(modal()).toBeNull();
  });

  it("is silent for assistive technology while it ticks and speaks at the start, one minute and ten seconds", async () => {
    useFakeTime();
    const { deps } = sources(() =>
      maintenanceFixture({
        phase: "scheduled",
        runId: "r-1",
        targetVersion: "0.2.0",
        startsAt: iso(75),
        serverTime: new Date().toISOString(),
      }),
    );
    shell(deps);
    await tick(10);

    const ticking = banner()?.querySelector("output[aria-live='off']");
    expect(ticking).not.toBeNull();
    const announcer = () => banner()?.querySelector<HTMLElement>("output[aria-live='polite']");
    expect(announcer()).not.toBeNull();

    const heard: string[] = [];
    for (let second = 0; second < 90; second += 1) {
      const current = text(announcer() as HTMLElement);
      if (heard.at(-1) !== current) {
        heard.push(current);
      }
      await tick(1000);
    }
    expect(heard).toEqual([
      "Maintenance announced: Restow will be updated to version 0.2.0 in 1 minute.",
      "Maintenance starts in one minute. Save your work.",
      "Maintenance starts in 10 seconds.",
      "Maintenance is starting now.",
    ]);
  });

  it("has a running variant that spins only when motion is welcome", async () => {
    useFakeTime();
    const { deps } = sources(() =>
      maintenanceFixture({
        phase: "running",
        runId: "r-1",
        targetVersion: "0.2.0",
        serverTime: new Date().toISOString(),
      }),
    );
    shell(deps);
    await tick(10);
    const bar = banner() as HTMLElement;
    expect(bar.dataset.variant).toBe("running");
    expect(text(bar)).toContain(
      "Maintenance in progress: Restow is being updated to version 0.2.0.",
    );
    const spinner = bar.querySelector("svg");
    expect(spinner?.getAttribute("class")).toContain("motion-safe:animate-spin");
    expect(spinner?.getAttribute("class")).not.toMatch(/(^|\s)animate-spin/);
  });

  it("words a build switch as a switch, scheduled and running", async () => {
    useFakeTime();
    let view = maintenanceFixture({
      phase: "scheduled",
      runId: "r-1",
      targetVersion: "0.2.1",
      switchTo: "full",
      startsAt: iso(272),
      serverTime: iso(0),
    });
    const { deps } = sources(() => ({ ...view, serverTime: new Date().toISOString() }));
    shell(deps);
    await tick(10);
    expect(text(banner() as HTMLElement)).toContain(
      "Maintenance in 04:32: Restow will switch to the full build (0.2.1). Save your work.",
    );
    expect(text(banner() as HTMLElement)).not.toContain("updated");

    view = { ...view, phase: "running", startsAt: iso(-10) };
    await tick(30_000);
    expect(text(banner() as HTMLElement)).toContain(
      "Maintenance in progress: Restow is switching to the full build (0.2.1).",
    );
  });

  it("tells a provider admin about a run that needs attention, with a link to the tab", async () => {
    useFakeTime();
    const { deps } = sources(() =>
      maintenanceFixture({
        phase: "failed",
        runId: "r-1",
        outcome: "needs_attention",
        serverTime: new Date().toISOString(),
      }),
    );
    shell(deps);
    await tick(10);
    expect(banner()?.dataset.variant).toBe("attention");
    expect(banner()?.querySelector("a")?.getAttribute("href")).toBe("/installation/updates");
    await mounted?.unmount();

    mounted = mount(
      <MaintenanceProvider deps={deps} reload={vi.fn()}>
        <MaintenanceBanner />
      </MaintenanceProvider>,
      { session: sessionAs({ isProviderAdmin: false, role: "tenant_user", providerRole: null }) },
    );
    await tick(10);
    expect(banner()).toBeNull();
  });

  it("shows nothing when nothing is announced", async () => {
    useFakeTime();
    const { deps } = sources(() => maintenanceFixture({ serverTime: new Date().toISOString() }));
    shell(deps);
    await tick(10);
    expect(banner()).toBeNull();
    expect(modal()).toBeNull();
  });
});

describe("the announcement toast", () => {
  it("shows once per run when the maintenance is announced while the page is open", async () => {
    useFakeTime();
    let view: MaintenanceView = maintenanceFixture({ serverTime: iso(0) });
    const { state, deps } = sources(() => ({ ...view, serverTime: new Date().toISOString() }));
    shell(deps);
    await tick(10);
    expect(toastSpy.info).not.toHaveBeenCalled();

    view = maintenanceFixture({
      phase: "scheduled",
      runId: "r-1",
      targetVersion: "0.2.0",
      startsAt: iso(300 + 30),
    });
    await tick(30_000);
    expect(toastSpy.info).toHaveBeenCalledTimes(1);
    expect(toastSpy.info.mock.calls[0]?.[0]).toBe(
      "Maintenance announced: Restow will be updated to version 0.2.0 in 5 minutes.",
    );

    // More polls of the same run say nothing more (the poll is close while it is announced).
    await tick(20_000);
    expect(toastSpy.info).toHaveBeenCalledTimes(1);

    // Cancelled and announced again: still the same run.
    view = maintenanceFixture({ serverTime: iso(0) });
    await tick(4000);
    view = maintenanceFixture({
      phase: "scheduled",
      runId: "r-1",
      targetVersion: "0.2.0",
      startsAt: iso(600),
    });
    await tick(31_000);
    expect(toastSpy.info).toHaveBeenCalledTimes(1);

    // A new run is a new announcement.
    view = maintenanceFixture({ serverTime: iso(0) });
    await tick(4000);
    view = maintenanceFixture({
      phase: "scheduled",
      runId: "r-2",
      targetVersion: "0.3.0",
      startsAt: iso(1200),
    });
    await tick(31_000);
    expect(toastSpy.info).toHaveBeenCalledTimes(2);
    expect(String(toastSpy.info.mock.calls[1]?.[0])).toContain("version 0.3.0");
    expect(state.apiCalls).toBeGreaterThan(5);
  });

  it("shows only the banner when the page is loaded during a maintenance", async () => {
    useFakeTime();
    const { deps } = sources(() =>
      maintenanceFixture({
        phase: "scheduled",
        runId: "r-1",
        targetVersion: "0.2.0",
        startsAt: iso(300),
        serverTime: new Date().toISOString(),
      }),
    );
    shell(deps);
    await tick(10);
    await tick(10_000);
    expect(banner()).not.toBeNull();
    expect(toastSpy.info).not.toHaveBeenCalled();
  });
});

describe("the modal", () => {
  const STATUSES: Record<UpdateStepId, StepStatus> = {
    prepare: "done",
    fetch: "done",
    backup: "running",
    stop: "pending",
    start: "pending",
    health: "pending",
    finish: "pending",
  };

  function staticSnapshot(view: MaintenanceView, apiReachable = true): MaintenanceSnapshot {
    return { view, apiReachable, offsetMs: 0, offsetSamples: [0], receivedAt: NOW };
  }

  function showModal(
    view: MaintenanceView,
    options: {
      apiReachable?: boolean;
      sawActiveRun?: boolean;
      dismissedRunId?: string | null;
      admin?: boolean;
    } = {},
  ) {
    const dismiss = vi.fn();
    mounted = mount(
      <StaticMaintenanceProvider
        value={{
          snapshot: staticSnapshot(view, options.apiReachable ?? true),
          phase: view.phase,
          sawActiveRun: options.sawActiveRun ?? true,
          dismissedRunId: options.dismissedRunId ?? null,
          dismiss,
        }}
      >
        <MaintenanceModal />
      </StaticMaintenanceProvider>,
      options.admin === false
        ? {
            session: sessionAs({ isProviderAdmin: false, role: "tenant_user", providerRole: null }),
          }
        : {},
    );
    return dismiss;
  }

  const running = (overrides: Partial<MaintenanceView> = {}) =>
    maintenanceFixture({
      phase: "running",
      runId: "r-1",
      targetVersion: "0.2.0",
      step: "backup",
      progress: 42,
      steps: UPDATE_STEPS.map((id) => ({ id, status: STATUSES[id] })),
      ...overrides,
    });

  it("lists the steps in order, each with its status, and the progress", () => {
    showModal(running());
    const element = modal() as HTMLElement;
    expect(element.getAttribute("aria-modal")).toBe("true");
    expect(element.getAttribute("role")).toBe("dialog");
    expect(text(element)).toContain("Restow is being updated to version 0.2.0");
    expect(text(element)).toContain("This page continues automatically.");

    const items = [...element.querySelectorAll<HTMLElement>("[data-step]")];
    expect(items.map((item) => item.dataset.step)).toEqual([...UPDATE_STEPS]);
    expect(items.map((item) => item.dataset.status)).toEqual([
      "done",
      "done",
      "running",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(items.map((item) => text(item))).toEqual([
      "Preparing the updateDone",
      "Fetching the new versionDone",
      "Backing up the databaseIn progress",
      "Stopping the servicesWaiting",
      "Starting the new versionWaiting",
      "Checking that everything runsWaiting",
      "Finishing upWaiting",
    ]);
    expect(items[2]?.getAttribute("aria-current")).toBe("step");
    expect(items[3]?.getAttribute("aria-current")).toBeNull();

    const progress = element.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute("aria-valuenow")).toBe("42");
    expect(text(element)).toContain("42 %");
  });

  it("shows failed and skipped steps too", () => {
    showModal(
      running({
        steps: [
          { id: "prepare", status: "done" },
          { id: "fetch", status: "skipped" },
          { id: "backup", status: "failed" },
        ],
      }),
    );
    const status = (id: string) =>
      modal()?.querySelector<HTMLElement>(`[data-step="${id}"]`)?.dataset.status;
    expect(status("fetch")).toBe("skipped");
    expect(status("backup")).toBe("failed");
    // A step the status does not list yet is waiting.
    expect(status("finish")).toBe("pending");
  });

  it("shows all steps waiting before any is reported", () => {
    showModal(
      maintenanceFixture({ phase: "running", runId: "r-1", targetVersion: "0.2.0", steps: [] }),
    );
    const statuses = [...(modal() as HTMLElement).querySelectorAll<HTMLElement>("[data-step]")].map(
      (item) => item.dataset.status,
    );
    expect(new Set(statuses)).toEqual(new Set(["pending"]));
    expect(statuses).toHaveLength(7);
  });

  it("shows the updater's message when it is translated and nothing when it is not", () => {
    showModal(
      running({ message: { code: "step.backup.dumping", params: { file: "restow-0.1.0.dump" } } }),
    );
    expect(text(modal()?.querySelector('[data-slot="maintenance-message"]') as HTMLElement)).toBe(
      "Writing the database backup restow-0.1.0.dump",
    );
  });

  it("never shows a code it cannot translate", async () => {
    showModal(running({ message: { code: "step.invented.thing", params: {} } }));
    expect(modal()?.querySelector('[data-slot="maintenance-message"]')).toBeNull();
    expect(text(modal() as HTMLElement)).not.toContain("step.invented");
    expect(text(modal() as HTMLElement)).not.toContain("maintenance.messages");
    await mounted?.unmount();

    showModal(
      running({ message: { code: "maintenance.messages.step.backup.dumping", params: {} } }),
    );
    expect(modal()?.querySelector('[data-slot="maintenance-message"]')).toBeNull();
  });

  it("names the failure behind a message that carries a failure code", () => {
    showModal(
      running({ message: { code: "rollback.restarting", params: { version: "unknown" } } }),
    );
    expect(text(modal()?.querySelector('[data-slot="maintenance-message"]') as HTMLElement)).toBe(
      "Restarting the previous version (unknown)",
    );
  });

  it("says the server is restarting, calmly, when the api does not answer", () => {
    showModal(running(), { apiReachable: false });
    const note = modal()?.querySelector('[data-slot="maintenance-unreachable"]') as HTMLElement;
    expect(text(note)).toBe("The server is restarting. This is expected.");
    expect(note.getAttribute("aria-live")).toBe("polite");
    // Not an error: nothing here is styled or announced as one.
    expect(note.getAttribute("role")).not.toBe("alert");
    expect(modal()?.querySelector('[role="alert"]')).toBeNull();
  });

  it("has no note while the api answers", () => {
    showModal(running());
    expect(modal()?.querySelector('[data-slot="maintenance-unreachable"]')).toBeNull();
  });

  it("cannot be dismissed while the update runs", async () => {
    const dismiss = showModal(running());
    const element = modal() as HTMLElement;
    expect(buttonByText(element, "Dismiss")).toBeNull();
    await act(async () => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(modal()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      document.body.click();
    });
    expect(modal()).not.toBeNull();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("keeps focus inside", () => {
    showModal(running());
    const element = modal() as HTMLElement;
    // Everything outside is hidden from assistive technology while the modal is open.
    expect(element.contains(document.activeElement)).toBe(true);
    expect(document.querySelector("[data-radix-focus-guard]")).not.toBeNull();
  });

  it("words a running build switch as a switch", () => {
    showModal(
      maintenanceFixture({
        phase: "running",
        runId: "r-1",
        targetVersion: "0.2.1",
        switchTo: "full",
      }),
    );
    expect(text(modal() as HTMLElement)).toContain("Restow is switching to the full build (0.2.1)");
    expect(text(modal() as HTMLElement)).not.toContain("being updated");
  });

  it("words a succeeded build switch as a switch", () => {
    showModal(
      maintenanceFixture({
        phase: "succeeded",
        runId: "r-1",
        outcome: "succeeded",
        targetVersion: "0.2.1",
        switchTo: "full",
      }),
    );
    expect(text(modal() as HTMLElement)).toContain("Switched to the full build (0.2.1)");
    expect(text(modal() as HTMLElement)).toContain("The full build is running.");
  });

  it("says a failed build switch changed nothing, in the words of a switch", () => {
    showModal(
      maintenanceFixture({
        phase: "failed",
        runId: "r-1",
        outcome: "unchanged",
        failureCode: "prepare.disk_space",
        switchTo: "full",
      }),
    );
    const element = modal() as HTMLElement;
    expect(text(element)).toContain("The switch to the full build could not start");
    expect(text(element)).toContain("the Community build is still running.");
  });

  it("says the update succeeded, and reloads on request", () => {
    const view = maintenanceFixture({
      phase: "succeeded",
      runId: "r-1",
      outcome: "succeeded",
      targetVersion: "0.2.0",
    });
    showModal(view);
    const element = modal() as HTMLElement;
    expect(text(element)).toContain("Updated to version 0.2.0");
    expect(text(element)).toContain("This page reloads by itself.");
    expect(buttonByText(element, "Reload now")).not.toBeNull();
    expect(buttonByText(element, "Dismiss")).not.toBeNull();
  });

  it("says nothing about a success this page did not watch", () => {
    showModal(maintenanceFixture({ phase: "succeeded", runId: "r-1", outcome: "succeeded" }), {
      sawActiveRun: false,
    });
    expect(modal()).toBeNull();
  });

  it("says the update could not start and nothing was changed", async () => {
    const view = maintenanceFixture({
      phase: "failed",
      runId: "r-1",
      outcome: "unchanged",
      failureCode: "prepare.disk_space",
    });
    const dismiss = showModal(view);
    const element = modal() as HTMLElement;
    expect(text(element)).toContain("The update could not start");
    expect(text(element)).toContain("Nothing was changed; the previous version is still running.");
    expect(text(element)).toContain("Reason: There is not enough free disk space.");
    await click(buttonByText(element, "Dismiss"));
    expect(dismiss).toHaveBeenCalledWith("r-1");
  });

  it("says the update was rolled back", () => {
    showModal(
      maintenanceFixture({
        phase: "failed",
        runId: "r-1",
        outcome: "rolled_back",
        failureCode: "health.timeout",
      }),
    );
    const element = modal() as HTMLElement;
    expect(text(element)).toContain("The update failed and was rolled back");
    expect(text(element)).toContain("The previous version runs again.");
    expect(text(element)).toContain("Reason: The new version did not become healthy in time.");
  });

  it("sends a provider admin to the Updates tab when the update needs attention, without a way to dismiss", () => {
    showModal(
      maintenanceFixture({
        phase: "failed",
        runId: "r-1",
        outcome: "needs_attention",
        failureCode: "start.failed",
      }),
      {
        dismissedRunId: "r-1",
      },
    );
    const element = modal() as HTMLElement;
    expect(text(element)).toContain(
      "The update failed after the database was migrated. An administrator has to restore it. Details are under Installation, Updates.",
    );
    expect(buttonByText(element, "Dismiss")).toBeNull();
    expect(element.querySelector("a")?.getAttribute("href")).toBe("/installation/updates");
  });

  it("tells everybody else that an administrator has been informed, and lets them dismiss it", async () => {
    const dismiss = showModal(
      maintenanceFixture({
        phase: "failed",
        runId: "r-1",
        outcome: "needs_attention",
        failureCode: "start.failed",
      }),
      { admin: false },
    );
    const element = modal() as HTMLElement;
    expect(text(element)).toContain("Restow is unavailable. An administrator has been informed.");
    expect(element.querySelector("a")).toBeNull();
    await click(buttonByText(element, "Dismiss"));
    expect(dismiss).toHaveBeenCalledWith("r-1");
  });

  it("does not show a run whose result was dismissed", () => {
    showModal(maintenanceFixture({ phase: "failed", runId: "r-1", outcome: "unchanged" }), {
      dismissedRunId: "r-1",
    });
    expect(modal()).toBeNull();
  });
});

describe("through an update that takes the api away", () => {
  const RUNNING = () =>
    maintenanceFixture({
      phase: "running",
      runId: "r-1",
      targetVersion: "0.2.0",
      step: "stop",
      progress: 55,
      runningVersion: "0.1.0",
      serverTime: new Date().toISOString(),
      steps: UPDATE_STEPS.map((id, index) => ({
        id,
        status: index < 3 ? "done" : index === 3 ? "running" : "pending",
      })),
    });

  it("keeps the modal and keeps polling when the connection fails", async () => {
    useFakeTime();
    const { state, deps } = sources(RUNNING);
    shell(deps);
    await tick(10);
    expect(modal()).not.toBeNull();
    expect(text(modal() as HTMLElement)).not.toContain("The server is restarting");

    state.api = () => restart();
    const before = state.apiCalls;
    await tick(2100);
    expect(modal()).not.toBeNull();
    expect(text(modal() as HTMLElement)).toContain("The server is restarting. This is expected.");
    // The steps it knew stay, and no error is shown or announced.
    expect(modal()?.querySelectorAll("[data-step]")).toHaveLength(7);
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(toastSpy.error).not.toHaveBeenCalled();

    await tick(10_000);
    // It keeps asking the api and the edge every two seconds.
    expect(state.apiCalls - before).toBeGreaterThanOrEqual(5);
    expect(state.edgeCalls).toBeGreaterThanOrEqual(5);
    expect(modal()).not.toBeNull();
  });

  it("does the same for a gateway that answers 502, 503 or 504 instead", async () => {
    for (const status of [502, 503, 504]) {
      useFakeTime();
      const { state, deps } = sources(RUNNING);
      shell(deps);
      await tick(10);
      state.api = () => gateway(status);
      await tick(2100);
      expect(text(modal() as HTMLElement), String(status)).toContain("The server is restarting");
      await tick(4000);
      expect(state.apiCalls, String(status)).toBeGreaterThanOrEqual(3);
      await mounted?.unmount();
      mounted = null;
      vi.useRealTimers();
    }
  });

  it("follows the edge's status while the api is away, and reloads once the new version answers", async () => {
    useFakeTime();
    const { state, deps } = sources(RUNNING);
    const reload = shell(deps);
    await tick(10);

    state.api = () => restart();
    state.edge = () =>
      edgeStatus(
        maintenanceFixture({
          phase: "running",
          runId: "r-1",
          targetVersion: "0.2.0",
          step: "start",
          progress: 80,
          steps: UPDATE_STEPS.map((id, index) => ({
            id,
            status: index < 4 ? "done" : index === 4 ? "running" : "pending",
          })),
          serverTime: new Date().toISOString(),
        }),
      );
    await tick(2100);
    expect(modal()?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "80",
    );
    expect(modal()?.querySelector<HTMLElement>('[data-step="start"]')?.dataset.status).toBe(
      "running",
    );

    // The edge learns the run finished before the api is back.
    state.edge = () =>
      edgeStatus(
        maintenanceFixture({
          phase: "succeeded",
          runId: "r-1",
          outcome: "succeeded",
          targetVersion: "0.2.0",
          progress: 100,
          serverTime: new Date().toISOString(),
        }),
      );
    await tick(2100);
    expect(text(modal() as HTMLElement)).toContain("Updated to version 0.2.0");
    expect(text(modal() as HTMLElement)).toContain("The server is restarting");
    expect(reload).not.toHaveBeenCalled();

    // The api answers on the new version: the page reloads, once.
    state.api = () =>
      maintenanceFixture({
        phase: "succeeded",
        runId: "r-1",
        outcome: "succeeded",
        targetVersion: "0.2.0",
        runningVersion: "0.2.0",
        progress: 100,
        serverTime: new Date().toISOString(),
      });
    await tick(2100);
    expect(reload).toHaveBeenCalledTimes(1);
    await tick(60_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when the api comes back on the same version", async () => {
    useFakeTime();
    const { state, deps } = sources(RUNNING);
    const reload = shell(deps);
    await tick(10);
    state.api = () => restart();
    await tick(2100);
    // Rolled back: the previous version answers again.
    state.api = () =>
      maintenanceFixture({
        phase: "failed",
        runId: "r-1",
        outcome: "rolled_back",
        runningVersion: "0.1.0",
        failureCode: "health.timeout",
        serverTime: new Date().toISOString(),
      });
    await tick(5000);
    expect(reload).not.toHaveBeenCalled();
    expect(text(modal() as HTMLElement)).toContain("The update failed and was rolled back");
  });

  it("reloads after a moment when the run this page watched succeeded on an unchanged version number", async () => {
    useFakeTime();
    const { state, deps } = sources(RUNNING);
    const reload = shell(deps);
    await tick(10);
    state.api = () =>
      maintenanceFixture({
        phase: "succeeded",
        runId: "r-1",
        outcome: "succeeded",
        targetVersion: "0.1.0",
        runningVersion: "0.1.0",
        serverTime: new Date().toISOString(),
      });
    await tick(2100);
    expect(reload).not.toHaveBeenCalled();
    await tick(3000);
    expect(reload).toHaveBeenCalledTimes(1);
    await tick(30_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload a page that loaded after the update, and never loops", async () => {
    useFakeTime();
    // A page that loaded on the new version and finds a finished run: nothing to do.
    const finished = () =>
      maintenanceFixture({
        phase: "succeeded",
        runId: "r-1",
        outcome: "succeeded",
        targetVersion: "0.2.0",
        runningVersion: "0.2.0",
        serverTime: new Date().toISOString(),
      });
    const first = sources(finished);
    const reloadFirst = shell(first.deps);
    await tick(10);
    await tick(40_000);
    expect(reloadFirst).not.toHaveBeenCalled();
    expect(modal()).toBeNull();
    await unmountShell();

    // An old page sees the new version, reloads, and remembers that it did (sessionStorage survives a reload).
    const second = sources(() =>
      maintenanceFixture({ runningVersion: "0.1.0", serverTime: new Date().toISOString() }),
    );
    const reloadSecond = shell(second.deps);
    await tick(10);
    second.state.api = () =>
      maintenanceFixture({ runningVersion: "0.2.0", serverTime: new Date().toISOString() });
    await tick(31_000);
    expect(reloadSecond).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem("restow.maintenance.reload")).toContain("version:0.2.0");
    await unmountShell();

    // The reloaded page loads on 0.2.0. An api that flaps back at once is not followed: a reload just happened.
    const third = sources(() =>
      maintenanceFixture({ runningVersion: "0.2.0", serverTime: new Date().toISOString() }),
    );
    const reloadThird = shell(third.deps);
    await tick(10);
    third.state.api = () =>
      maintenanceFixture({ runningVersion: "0.1.0", serverTime: new Date().toISOString() });
    await tick(31_000);
    expect(reloadThird).not.toHaveBeenCalled();
    await unmountShell();

    // A page that started long after may follow it once, but never a version it already reloaded for.
    await tick(120_000);
    const fourth = sources(() =>
      maintenanceFixture({ runningVersion: "0.1.0", serverTime: new Date().toISOString() }),
    );
    const reloadFourth = shell(fourth.deps);
    await tick(10);
    fourth.state.api = () =>
      maintenanceFixture({ runningVersion: "0.2.0", serverTime: new Date().toISOString() });
    await tick(31_000);
    expect(reloadFourth).not.toHaveBeenCalled();
  });

  it("does not reload at all when the browser gives no session storage to remember it in", async () => {
    useFakeTime();
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      const { state, deps } = sources(RUNNING);
      const reload = shell(deps);
      await tick(10);
      state.api = () =>
        maintenanceFixture({
          phase: "succeeded",
          runId: "r-1",
          outcome: "succeeded",
          targetVersion: "0.2.0",
          runningVersion: "0.2.0",
          serverTime: new Date().toISOString(),
        });
      await tick(10_000);
      expect(reload).not.toHaveBeenCalled();
      // The modal still offers the manual way.
      expect(buttonByText(modal() as HTMLElement, "Reload now")).not.toBeNull();
    } finally {
      if (original) {
        Object.defineProperty(window, "sessionStorage", original);
      }
    }
  });

  it("stays silent when polling fails while nothing is going on", async () => {
    useFakeTime();
    const { state, deps } = sources(() =>
      maintenanceFixture({ serverTime: new Date().toISOString() }),
    );
    shell(deps);
    await tick(10);

    state.api = () => restart();
    await tick(31_000);
    state.api = () => gateway(503);
    await tick(31_000);
    state.api = () => new ApiError(500, null, "boom");
    await tick(31_000);

    expect(banner()).toBeNull();
    expect(modal()).toBeNull();
    expect(document.body.textContent?.trim()).toBe("");
    expect(toastSpy.error).not.toHaveBeenCalled();
    expect(state.edgeCalls).toBe(0);
    // And it recovers by itself.
    state.api = () =>
      maintenanceFixture({
        phase: "running",
        runId: "r-9",
        targetVersion: "0.9.0",
        serverTime: new Date().toISOString(),
      });
    await tick(31_000);
    expect(modal()).not.toBeNull();
  });
});

describe("dismissing a result", () => {
  it("remembers the dismissed run in this browser", async () => {
    useFakeTime();
    const { deps } = sources(() =>
      maintenanceFixture({
        phase: "failed",
        runId: "r-7",
        outcome: "unchanged",
        failureCode: "backup.failed",
        finishedAt: iso(-30),
        serverTime: new Date().toISOString(),
      }),
    );
    shell(deps);
    await tick(10);
    expect(text(modal() as HTMLElement)).toContain("The update could not start");

    await click(buttonByText(modal() as HTMLElement, "Dismiss"));
    expect(modal()).toBeNull();
    expect(window.localStorage.getItem("restow.maintenance.dismissed")).toBe("r-7");

    // A new page load does not show it again.
    await unmountShell();
    shell(deps);
    await tick(10);
    expect(modal()).toBeNull();
  });

  it("shows a newer run's result even after an older one was dismissed", async () => {
    useFakeTime();
    window.localStorage.setItem("restow.maintenance.dismissed", "r-6");
    const { deps } = sources(() =>
      maintenanceFixture({
        phase: "failed",
        runId: "r-7",
        outcome: "rolled_back",
        finishedAt: iso(-30),
        serverTime: new Date().toISOString(),
      }),
    );
    shell(deps);
    await tick(10);
    expect(text(modal() as HTMLElement)).toContain("rolled back");
  });

  it("works without storage: the dismissal lasts for this page load", async () => {
    useFakeTime();
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      const { deps } = sources(() =>
        maintenanceFixture({
          phase: "failed",
          runId: "r-7",
          outcome: "unchanged",
          finishedAt: iso(-30),
          serverTime: new Date().toISOString(),
        }),
      );
      shell(deps);
      await tick(10);
      await click(buttonByText(modal() as HTMLElement, "Dismiss"));
      expect(modal()).toBeNull();
    } finally {
      if (original) {
        Object.defineProperty(window, "localStorage", original);
      }
    }
  });
});
