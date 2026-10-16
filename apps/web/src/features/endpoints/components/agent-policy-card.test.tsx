// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import {
  cleanLevel,
  DEFAULT_AGENT_POLICY,
  firstPolicyProblem,
  JOB_POLICY_KEYS,
  resolvedDefaults,
  resolvedGlobal,
  resolveOnTop,
  type TenantAgentPolicyView,
} from "../agent-policy.js";
import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import { AgentPolicyCard } from "./agent-policy-card.js";

/**
 * The tenant's level of the agent policy (Agents section of the tenant page): every setting says
 * what applies, where it comes from and whether the installation locked it; a locked one cannot be
 * set; saving sends only the tenant's own, unlocked settings.
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));

const fetchTenantAgentPolicy = vi.fn();
const saveTenantAgentPolicy = vi.fn();
vi.mock("../agent-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-policy.js")>();
  return {
    ...actual,
    fetchTenantAgentPolicy: (...args: unknown[]) => fetchTenantAgentPolicy(...args),
    saveTenantAgentPolicy: (...args: unknown[]) => saveTenantAgentPolicy(...args),
  };
});

const NIGHT = { days: [1, 2, 3, 4, 5], from: "20:00", to: "06:00" };

function view(over: Partial<TenantAgentPolicyView> = {}): TenantAgentPolicyView {
  const base: TenantAgentPolicyView = {
    global: { settings: { backupWindow: NIGHT }, locks: ["backupWindow"] },
    settings: { retries: 2 },
    defaults: DEFAULT_AGENT_POLICY,
    effective: resolvedDefaults(),
    ...over,
  };
  return base;
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

const setting = (key: string) =>
  document.querySelector<HTMLElement>(`[data-slot="policy-setting"][data-key="${key}"]`);

describe("AgentPolicyCard", () => {
  it("says where each value comes from and keeps a locked one out of reach", async () => {
    fetchTenantAgentPolicy.mockResolvedValue(view());
    await page.render(<AgentPolicyCard />);
    await page.settle();

    const window = setting("backupWindow");
    expect(window?.textContent).toContain("Mon–Fri, 20:00 to 06:00 the next day");
    expect(window?.querySelector('[data-slot="policy-source"]')?.textContent).toBe("Installation");
    expect(window?.querySelector('[data-slot="policy-locked"]')).not.toBeNull();
    expect(window?.querySelector('[data-slot="policy-locked-note"]')).not.toBeNull();
    expect(window?.querySelector('button[role="switch"]')).toBeNull();

    const retries = setting("retries");
    expect(retries?.querySelector('[data-slot="policy-source"]')?.textContent).toBe("Tenant");
    expect(retries?.textContent).toContain("2 retries");

    const catchUp = setting("catchUp");
    expect(catchUp?.querySelector('[data-slot="policy-source"]')?.textContent).toBe("Default");
    expect(catchUp?.textContent).toContain("As soon as the machine is on again");
  });

  it("saves the tenant's own settings", async () => {
    fetchTenantAgentPolicy.mockResolvedValue(view());
    saveTenantAgentPolicy.mockResolvedValue({ ...view(), machinesUpdated: 3 });
    await page.render(<AgentPolicyCard />);
    await page.settle();

    const ac = setting("onlyOnAcPower")?.querySelector<HTMLButtonElement>('button[role="switch"]');
    await act(async () => ac?.click());
    const save = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Save policy",
    );
    await act(async () => save?.click());
    await page.settle();
    expect(saveTenantAgentPolicy).toHaveBeenCalledWith({ onlyOnAcPower: false, retries: 2 });
  });
});

describe("the policy helpers", () => {
  it("resolve a level on top of the one above, a lock wins", () => {
    const above = resolvedGlobal(view());
    expect(above.backupWindow).toEqual({ value: NIGHT, source: "global", locked: true });
    const job = resolveOnTop(above, { backupWindow: null, retries: 0 }, "job");
    expect(job.backupWindow.source).toBe("global");
    expect(job.retries).toEqual({ value: 0, source: "job", locked: false });
  });

  it("clean a level and find its first problem", () => {
    expect(
      cleanLevel({ retries: 1, bandwidthKbps: 5, backupWindow: null }, JOB_POLICY_KEYS, [
        "backupWindow",
      ]),
    ).toEqual({ retries: 1 });
    expect(firstPolicyProblem({ retries: 11 })).toEqual({ key: "retries", problem: "retries" });
    expect(firstPolicyProblem({ backupWindow: { days: [], from: "20:00", to: "06:00" } })).toEqual({
      key: "backupWindow",
      problem: "days",
    });
    expect(firstPolicyProblem({ bandwidthKbps: null, retries: 0 })).toBeNull();
  });
});
