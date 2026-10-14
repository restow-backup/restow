// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { RestartsView } from "./api";
import { RestartCard } from "./components/restart-card";
import {
  RESTARTS_ACTIVE_REFRESH_MS,
  RESTARTS_IDLE_REFRESH_MS,
  restartsRefetchInterval,
} from "./hooks";
import { DEFAULT_PROJECT_DIR, restartCommand, restartGroups } from "./presenters";
import { RestartBanner } from "./restart-banner";
import {
  type Mounted,
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  json,
  mount,
  problem,
  routedFetch,
  sessionAs,
} from "./testing";

/**
 * "Restart required": the card on the Updates tab (why, "Restart now" when the
 * updater can and the viewer may, always the command), the notice for
 * provider administrators, and the pure parts behind them.
 */

const toastSpy = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));

vi.mock("@/components/ui/sonner", () => ({
  toast: Object.assign(vi.fn(), toastSpy),
  Toaster: () => null,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
      <a href={to} {...props}>
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
  vi.stubGlobal("fetch", vi.fn());
  toastSpy.info.mockReset();
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function restartsFixture(overrides: Partial<RestartsView> = {}): RestartsView {
  return {
    requests: [{ service: "worker", reason: "some_reason", requestedAt: "2026-10-01T09:00:00Z" }],
    updater: "ready",
    lastRestart: null,
    projectDir: "/srv/restow",
    ...overrides,
  };
}

function text(scope: ParentNode = document.body): string {
  return (scope.textContent ?? "").replace(/\s+/g, " ").trim();
}

function slot(name: string, scope: ParentNode = document.body): HTMLElement | null {
  return scope.querySelector<HTMLElement>(`[data-slot="${name}"]`);
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="alertdialog"]');
}

function codes(): string[] {
  return [...document.body.querySelectorAll("code")].map((code) => code.textContent ?? "");
}

describe("the pure parts", () => {
  it("builds the command in the installation's directory, or the usual one", () => {
    expect(restartCommand("worker", "/srv/restow")).toBe(
      "cd /srv/restow && docker compose restart worker",
    );
    expect(restartCommand("api", null)).toBe(
      `cd ${DEFAULT_PROJECT_DIR} && docker compose restart api`,
    );
    // A directory with a space or a quote stays one shell word.
    expect(restartCommand("scheduler", "/srv/my restow")).toBe(
      "cd '/srv/my restow' && docker compose restart scheduler",
    );
    expect(restartCommand("api", "/srv/it's")).toBe(
      "cd '/srv/it'\\''s' && docker compose restart api",
    );
  });

  it("groups the requests by service, in a fixed order", () => {
    expect(
      restartGroups([
        { service: "worker", reason: "b", requestedAt: "" },
        { service: "api", reason: "a", requestedAt: "" },
        { service: "worker", reason: "c", requestedAt: "" },
      ]),
    ).toEqual([
      { service: "api", reasons: ["a"] },
      { service: "worker", reasons: ["b", "c"] },
    ]);
  });

  it("polls closely only while a restart takes effect", () => {
    const now = Date.parse("2026-10-01T09:00:00Z");
    expect(restartsRefetchInterval(undefined)).toBe(false);
    expect(restartsRefetchInterval(restartsFixture(), now)).toBe(RESTARTS_IDLE_REFRESH_MS);
    const running = restartsFixture({
      lastRestart: {
        service: "worker",
        status: "running",
        startedAt: "2026-10-01T09:00:00Z",
        finishedAt: null,
      },
    });
    expect(restartsRefetchInterval(running, now)).toBe(RESTARTS_ACTIVE_REFRESH_MS);
    const failed = restartsFixture({
      lastRestart: {
        service: "worker",
        status: "failed",
        startedAt: "2026-10-01T09:00:00Z",
        finishedAt: "2026-10-01T09:00:10Z",
      },
    });
    expect(restartsRefetchInterval(failed, now)).toBe(RESTARTS_IDLE_REFRESH_MS);
    expect(restartsRefetchInterval(restartsFixture({ requests: [] }), now)).toBeGreaterThan(
      RESTARTS_IDLE_REFRESH_MS,
    );
  });
});

describe("the card on the Updates tab", () => {
  it("shows nothing while no service needs a restart", () => {
    mounted = mount(<RestartCard restarts={restartsFixture({ requests: [] })} canChange />);
    expect(slot("restart-required")).toBeNull();
  });

  it("says what needs a restart and why, with the button and the command", () => {
    mounted = mount(<RestartCard restarts={restartsFixture()} canChange />);
    expect(text()).toContain("Restart required");
    expect(text()).toContain("Restart the worker");
    // An unknown reason reads as the generic text, never as a raw key.
    expect(text()).toContain("A change takes effect only after a restart.");
    expect(text()).not.toContain("restart.reasons");
    expect(buttonByText(document.body, "Restart now")).not.toBeNull();
    expect(codes()).toEqual(["cd /srv/restow && docker compose restart worker"]);
    expect(slot("restart-directory-note")).toBeNull();
  });

  it("restarts only after a confirmation, through the api, and says so", async () => {
    const { mock, requests } = routedFetch({
      "POST /updates/restarts/worker": () =>
        json(
          restartsFixture({
            lastRestart: {
              service: "worker",
              status: "running",
              startedAt: "2026-10-01T09:00:00Z",
              finishedAt: null,
            },
          }),
        ),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<RestartCard restarts={restartsFixture()} canChange />);

    await click(buttonByText(document.body, "Restart now"));
    expect(requests).toEqual([]);
    expect(text(dialog() as HTMLElement)).toContain("Restart the worker now?");
    expect(text(dialog() as HTMLElement)).toContain("docker compose restart worker");
    await click(buttonByText(dialog() as HTMLElement, "Restart now"));
    await flush();
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /updates/restarts/worker",
    ]);
    expect(toastSpy.info).toHaveBeenCalledWith("The updater is restarting the worker.");
  });

  it("keeps the dialog open with the reason when the api refuses", async () => {
    const { mock } = routedFetch({
      "POST /updates/restarts/worker": () => problem("urn:restow:problem:restart-unsupported", 409),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<RestartCard restarts={restartsFixture()} canChange />);
    await click(buttonByText(document.body, "Restart now"));
    await click(buttonByText(dialog() as HTMLElement, "Restart now"));
    await flush();
    expect(text(dialog() as HTMLElement)).toContain("cannot restart services yet");
  });

  it.each([
    ["unavailable", "The updater is not running"],
    ["unsupported", "cannot restart services yet"],
    ["busy", "An update or another restart is running"],
    ["demo", "public demo"],
  ] as const)("offers only the command while the updater is %s", (updater, note) => {
    mounted = mount(<RestartCard restarts={restartsFixture({ updater })} canChange />);
    expect(buttonByText(document.body, "Restart now")).toBeNull();
    expect(text(slot("restart-availability") as HTMLElement)).toContain(note);
    expect(text()).toContain("Run this command on the server:");
    expect(codes()).toEqual(["cd /srv/restow && docker compose restart worker"]);
  });

  it("offers only the command to a role that may not restart", () => {
    mounted = mount(<RestartCard restarts={restartsFixture()} canChange={false} />);
    expect(buttonByText(document.body, "Restart now")).toBeNull();
    expect(slot("restart-owner-only")).not.toBeNull();
    expect(codes()).toHaveLength(1);
  });

  it("names the usual directory, and says to adapt it, when the real one is unknown", () => {
    mounted = mount(
      <RestartCard
        restarts={restartsFixture({ projectDir: null, updater: "unavailable" })}
        canChange
      />,
    );
    expect(codes()).toEqual(["cd /opt/restow && docker compose restart worker"]);
    expect(text(slot("restart-directory-note") as HTMLElement)).toContain(
      "Use the directory of your installation",
    );
  });

  it("follows a restart that runs", () => {
    mounted = mount(
      <RestartCard
        restarts={restartsFixture({
          lastRestart: {
            service: "worker",
            status: "running",
            startedAt: "2026-10-01T09:00:00Z",
            finishedAt: null,
          },
        })}
        canChange
      />,
    );
    expect(text(slot("restart-progress") as HTMLElement)).toContain(
      "The updater is restarting the worker.",
    );
  });

  it("says when the last restart failed, without the success tone", async () => {
    const at = "2026-10-01T09:00:00Z";
    mounted = mount(
      <RestartCard
        restarts={restartsFixture({
          lastRestart: { service: "worker", status: "failed", startedAt: at, finishedAt: at },
        })}
        canChange
      />,
    );
    await flush();
    expect(slot("restart-failed")).not.toBeNull();
    expect(document.body.innerHTML).not.toMatch(/success/);
  });
});

describe("the notice for provider administrators", () => {
  it("names the services and links to the Updates tab", async () => {
    const { mock } = routedFetch({
      "GET /updates/restarts": () =>
        json(
          restartsFixture({
            requests: [
              { service: "api", reason: "x", requestedAt: "2026-10-01T09:00:00Z" },
              { service: "worker", reason: "y", requestedAt: "2026-10-01T09:00:00Z" },
            ],
          }),
        ),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<RestartBanner />);
    await flush();
    const banner = slot("restart-banner") as HTMLElement;
    expect(text(banner)).toContain("Restart required: API, worker.");
    expect(banner.querySelector("a")?.getAttribute("href")).toContain("updates");
  });

  it("is not shown while nothing needs a restart", async () => {
    const { mock } = routedFetch({
      "GET /updates/restarts": () => json(restartsFixture({ requests: [] })),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<RestartBanner />);
    await flush();
    expect(slot("restart-banner")).toBeNull();
  });

  it("asks nothing for anyone but a provider administrator", async () => {
    const { mock, requests } = routedFetch({});
    vi.stubGlobal("fetch", mock);
    mounted = mount(<RestartBanner />, {
      session: sessionAs({ isProviderAdmin: false, role: "tenant_user", providerRole: null }),
    });
    await flush();
    expect(requests).toEqual([]);
    expect(slot("restart-banner")).toBeNull();
  });
});
