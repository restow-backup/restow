// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { AgentUpdates } from "../api.js";
import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import { AgentUpdatesCard } from "./agent-updates-card.js";

/**
 * The tenant's setting for automatic agent updates (Agents section of the tenant
 * page): one switch for the whole tenant, which works before the first machine
 * exists, and the machines that are paused on their own, listed as overrides
 * that are lifted one by one or all at once.
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
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
  };
});

const fetchAgentUpdates = vi.fn();
const setAgentUpdates = vi.fn();
const resumeMachineUpdates = vi.fn();
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return {
    ...actual,
    fetchAgentUpdates: (...args: unknown[]) => fetchAgentUpdates(...args),
    setAgentUpdates: (...args: unknown[]) => setAgentUpdates(...args),
    resumeMachineUpdates: (...args: unknown[]) => resumeMachineUpdates(...args),
  };
});

const MACHINE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function state(over: Partial<AgentUpdates> = {}): AgentUpdates {
  return { paused: false, endpoints: 0, overrides: [], ...over };
}

let page: Mounted;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  vi.clearAllMocks();
  page = mount();
});
afterEach(() => {
  page.unmount();
});

async function open() {
  await page.render(<AgentUpdatesCard />);
  await page.settle();
}

const toggle = () =>
  document.querySelector<HTMLButtonElement>('[data-slot="agent-updates"] button[role="switch"]');

describe("AgentUpdatesCard", () => {
  it("can be set before the tenant has a machine, and says it covers machines added later", async () => {
    fetchAgentUpdates.mockResolvedValue(state());
    setAgentUpdates.mockResolvedValue(state({ paused: true }));
    await open();
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    expect(page.text()).toContain("signed by the maintainer");
    fetchAgentUpdates.mockResolvedValue(state({ paused: true }));
    await page.click(toggle() as Element);
    await page.settle();
    expect(setAgentUpdates).toHaveBeenCalledWith(true, undefined);
    expect(page.text()).toContain("Paused for every machine, also for machines added later");
  });

  it("lists the machines paused on their own and lifts one of them", async () => {
    fetchAgentUpdates.mockResolvedValue(
      state({
        endpoints: 2,
        overrides: [{ id: MACHINE, name: "db-01", profile: "server" }],
      }),
    );
    resumeMachineUpdates.mockResolvedValue(state({ endpoints: 2 }));
    await open();
    const overrides = document.querySelector('[data-slot="agent-update-overrides"]');
    expect(overrides?.textContent).toContain("1 machine is paused on its own");
    expect(overrides?.querySelector(`a[href="/inventory/${MACHINE}"]`)?.textContent).toBe("db-01");
    // One machine: resuming it is enough, no "Resume all".
    expect(overrides?.textContent).not.toContain("Resume all");
    fetchAgentUpdates.mockResolvedValue(state({ endpoints: 2 }));
    const resume = [...(overrides?.querySelectorAll("button") ?? [])].find((button) =>
      button.textContent?.includes("Resume this machine"),
    );
    await page.click(resume as Element);
    await page.settle();
    expect(resumeMachineUpdates).toHaveBeenCalledWith(MACHINE);
    expect(document.querySelector('[data-slot="agent-update-overrides"]')).toBeNull();
  });

  it("lifts every machine's own pause at once, leaving the tenant's setting as it is", async () => {
    fetchAgentUpdates.mockResolvedValue(
      state({
        paused: true,
        endpoints: 3,
        overrides: [
          { id: MACHINE, name: "db-01", profile: "server" },
          { id: OTHER, name: "laptop", profile: "client" },
        ],
      }),
    );
    setAgentUpdates.mockResolvedValue(state({ paused: true, endpoints: 3 }));
    await open();
    const all = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Resume all"),
    );
    await page.click(all as Element);
    await page.settle();
    expect(setAgentUpdates).toHaveBeenCalledWith(true, true);
  });
});
