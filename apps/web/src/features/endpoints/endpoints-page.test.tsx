// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";

import type { EndpointSummary, EnrollmentToken } from "./api.js";
import { type Mounted, mount } from "./dom-harness.js";
import { EndpointsPage } from "./endpoints-page.js";
import "./i18n.js";

const session = { status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } };
vi.mock("@/lib/session", () => ({
  useSession: () => session,
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return {
    ...actual,
    Dialog: { ...actual.Dialog, Portal: InPlacePortal },
    AlertDialog: { ...actual.AlertDialog, Portal: InPlacePortal },
  };
});
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

const fetchEndpoints = vi.fn();
const fetchTokens = vi.fn();
const revokeToken = vi.fn();
const fetchAgentUpdates = vi.fn();
const setAgentUpdates = vi.fn();
vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    fetchEndpoints: (...args: unknown[]) => fetchEndpoints(...args),
    fetchTokens: (...args: unknown[]) => fetchTokens(...args),
    revokeToken: (...args: unknown[]) => revokeToken(...args),
    fetchAgentUpdates: (...args: unknown[]) => fetchAgentUpdates(...args),
    setAgentUpdates: (...args: unknown[]) => setAgentUpdates(...args),
  };
});

function endpoint(over: Partial<EndpointSummary> = {}): EndpointSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    hostname: "web-01",
    displayName: null,
    os: "linux",
    arch: "amd64",
    profile: "server",
    agentVersion: "0.1.0",
    osVersion: null,
    status: "active",
    connection: "online",
    agentState: "idle",
    lastSeenAt: "2026-09-30T09:58:00.000Z",
    lastBackupAt: "2026-09-30T09:03:00.000Z",
    lastSuccessAt: "2026-09-30T09:03:00.000Z",
    nextRunAt: null,
    readiness: {
      state: "green",
      checkedAt: null,
      overdue: false,
      basis: null,
      latestSnapshotId: "s",
    },
    latestRun: null,
    attention: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    revokedAt: null,
    ...over,
  };
}

function token(over: Partial<EnrollmentToken> = {}): EnrollmentToken {
  return {
    id: "tok-1",
    profile: "server",
    displayName: "Build server",
    createdAt: "2026-09-30T09:00:00.000Z",
    expiresAt: "2026-10-01T09:00:00.000Z",
    state: "valid",
    usedByEndpointId: null,
    ...over,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("EndpointsPage", () => {
  let page: Mounted;

  beforeEach(() => {
    fetchEndpoints.mockReset();
    fetchTokens.mockReset();
    revokeToken.mockReset();
    fetchEndpoints.mockResolvedValue([]);
    fetchTokens.mockResolvedValue([]);
    fetchAgentUpdates.mockReset();
    setAgentUpdates.mockReset();
    fetchAgentUpdates.mockResolvedValue({ paused: false, endpoints: 0 });
  });
  afterEach(() => page?.unmount());

  async function open(area: "agents" | "servers" | "clients") {
    page = mount();
    await page.render(<EndpointsPage area={area} />);
    await page.settle();
  }

  it("pauses automatic agent updates for the whole tenant, once it has a machine", async () => {
    await open("agents");
    expect(document.querySelector('[data-slot="agent-updates"]')).toBeNull();
    page.unmount();
    fetchAgentUpdates.mockResolvedValue({ paused: false, endpoints: 2 });
    setAgentUpdates.mockResolvedValue({ paused: true, endpoints: 2 });
    await open("agents");
    const card = document.querySelector('[data-slot="agent-updates"]');
    expect(card?.textContent).toContain("Automatic agent updates");
    expect(card?.textContent).toContain("signed by the maintainer");
    const toggle = card?.querySelector('button[role="switch"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fetchAgentUpdates.mockResolvedValue({ paused: true, endpoints: 2 });
    await page.click(toggle);
    await page.settle();
    expect(setAgentUpdates).toHaveBeenCalledWith(true);
    expect(document.querySelector('[data-slot="agent-updates"]')?.textContent).toContain(
      "Paused for every machine of this tenant",
    );
  });

  it("asks the API for servers only on the servers page, clients only on clients, all on agents", async () => {
    await open("servers");
    expect(fetchEndpoints).toHaveBeenLastCalledWith("server");
    page.unmount();
    await open("clients");
    expect(fetchEndpoints).toHaveBeenLastCalledWith("client");
    page.unmount();
    await open("agents");
    expect(fetchEndpoints).toHaveBeenLastCalledWith(undefined);
  });

  it("lists the machines and says plainly what the backup is and is not", async () => {
    fetchEndpoints.mockResolvedValue([
      endpoint({ displayName: "Web front" }),
      endpoint({
        id: "22222222-2222-4222-8222-222222222222",
        hostname: "db-01",
        connection: "offline",
      }),
    ]);
    await open("servers");
    expect(page.text()).toContain("Web front");
    expect(page.text()).toContain("db-01");
    expect(page.text()).toContain("Online");
    expect(page.text()).toContain("Offline");
    expect(page.text()).toContain("no disk images and no bare-metal restore");
    expect(page.text()).toContain("never overwrites anything");
    expect(
      document.querySelector('a[href="/inventory/11111111-1111-4111-8111-111111111111"]'),
    ).not.toBeNull();
  });

  it("is the inventory with the filter chips All, Servers and Clients, one pressed", async () => {
    const onKindChange = vi.fn();
    page = mount();
    await page.render(<EndpointsPage area="servers" onKindChange={onKindChange} />);
    await page.settle();
    expect(document.querySelector("h1")?.textContent).toBe("Inventory");
    const group = document.querySelector('[data-slot="inventory-chips"]');
    // A fieldset is a group for assistive technology, named by its legend.
    expect(group?.tagName).toBe("FIELDSET");
    expect(group?.querySelector("legend")?.textContent).toBe("Filter machines");
    const chips = [...(group?.querySelectorAll("button") ?? [])];
    expect(chips.map((chip) => chip.textContent)).toEqual(["All", "Servers", "Clients"]);
    expect(chips.map((chip) => chip.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    // No "Unprotected" chip before jobs exist (0.2.0).
    expect(group?.textContent).not.toMatch(/Unprotected/);
    await page.click(chips[2] as HTMLElement);
    expect(onKindChange).toHaveBeenLastCalledWith("client");
    await page.click(chips[0] as HTMLElement);
    expect(onKindChange).toHaveBeenLastCalledWith(undefined);
  });

  it("shows no chips where the page is not the inventory", async () => {
    await open("agents");
    expect(document.querySelector('[data-slot="inventory-chips"]')).toBeNull();
  });

  it("shows an empty state with a call to action for servers", async () => {
    await open("servers");
    expect(page.text()).toContain("No servers yet");
    const buttons = [...document.querySelectorAll("button")].filter(
      (b) => b.textContent === "New server",
    );
    // One in the header, one in the empty state.
    expect(buttons).toHaveLength(2);
    expect(page.maybeByText("button", "New client")).toBeNull();
  });

  it("shows the client variant of the empty state", async () => {
    await open("clients");
    expect(page.text()).toContain("No clients yet");
    expect(page.maybeByText("button", "New client")).not.toBeNull();
    expect(page.maybeByText("button", "New server")).toBeNull();
  });

  it("offers both kinds on the agents page", async () => {
    await open("agents");
    expect(page.maybeByText("button", "New server")).not.toBeNull();
    expect(page.maybeByText("button", "New client")).not.toBeNull();
  });

  it("opens the wizard from the new button", async () => {
    await open("servers");
    expect(page.text()).not.toContain("Operating system");
    await page.click(page.byText("button", "New server"));
    await page.settle();
    expect(page.text()).toContain("Operating system");
    expect(page.text()).toContain("Planned");
  });

  it("shows why the list could not be loaded, with a retry", async () => {
    fetchEndpoints.mockRejectedValue(new ApiError(500, null, "boom"));
    await open("servers");
    expect(page.text()).toContain("The machines could not be loaded");
    expect(page.maybeByText("button", "Retry")).not.toBeNull();
  });

  it("lists the pending enrollments of the kind it shows, and revokes one after a confirmation", async () => {
    fetchTokens.mockResolvedValue([
      token(),
      token({ id: "tok-2", profile: "client", displayName: "Laptop" }),
      token({ id: "tok-3", state: "used", displayName: "Used one" }),
      token({ id: "tok-4", state: "expired", displayName: "Old one" }),
    ]);
    revokeToken.mockResolvedValue(undefined);
    await open("servers");
    const section = document.querySelector('[data-slot="pending-enrollments"]');
    expect(section?.textContent).toContain("Pending enrollments");
    expect(section?.textContent).toContain("Build server");
    expect(section?.textContent).not.toContain("Laptop");
    expect(section?.textContent).not.toContain("Used one");
    expect(section?.textContent).not.toContain("Old one");

    await page.click(page.byText("button", "Revoke"));
    expect(revokeToken).not.toHaveBeenCalled();
    await page.click(page.byText('[role="alertdialog"] button[type="submit"]', "Revoke command"));
    await page.settle();
    expect(revokeToken).toHaveBeenCalledWith("tok-1");
  });

  it("asks for the valid commands only, and for every state when the switch is turned on", async () => {
    fetchTokens.mockImplementation(async (state?: string) =>
      state === "all"
        ? [
            token(),
            token({ id: "tok-3", state: "used", displayName: "Used one" }),
            token({ id: "tok-4", state: "expired", displayName: "Old one" }),
            token({ id: "tok-5", state: "revoked", displayName: "Withdrawn one" }),
            token({ id: "tok-6", profile: "client", state: "used", displayName: "Laptop used" }),
          ]
        : [token()],
    );
    await open("servers");
    expect(fetchTokens).toHaveBeenCalledWith("valid");
    expect(fetchTokens).not.toHaveBeenCalledWith("all");
    const section = () => document.querySelector('[data-slot="pending-enrollments"]');
    expect(section()?.textContent).toContain("Build server");
    expect(section()?.textContent).not.toContain("Used one");

    await page.click(section()?.querySelector('[role="checkbox"]') as HTMLElement);
    await page.settle();
    expect(fetchTokens).toHaveBeenCalledWith("all");
    const rows = [...(section()?.querySelectorAll("li") ?? [])];
    expect(rows.map((row) => row.getAttribute("data-token-state"))).toEqual([
      "valid",
      "used",
      "expired",
      "revoked",
    ]);
    expect(section()?.textContent).toContain("Used one");
    expect(section()?.textContent).toContain("Expired");
    expect(section()?.textContent).not.toContain("Laptop used");
    // Only a valid command can be revoked.
    expect(section()?.querySelectorAll("button").length).toBeGreaterThan(0);
    expect(rows[1]?.querySelector("button")).toBeNull();
  });

  it("hides the pending section when no enrollment is open", async () => {
    fetchTokens.mockResolvedValue([token({ state: "used" })]);
    await open("servers");
    expect(document.querySelector('[data-slot="pending-enrollments"]')).toBeNull();
  });

  it("shows every open enrollment on the agents page", async () => {
    fetchTokens.mockResolvedValue([
      token(),
      token({ id: "tok-2", profile: "client", displayName: "Laptop" }),
    ]);
    await open("agents");
    const section = document.querySelector('[data-slot="pending-enrollments"]');
    expect(section?.textContent).toContain("Build server");
    expect(section?.textContent).toContain("Laptop");
  });
});
