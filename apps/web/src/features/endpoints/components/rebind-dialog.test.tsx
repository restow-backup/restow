// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { CreatedRebindToken } from "../api.js";
import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import { RebindDialog } from "./rebind-dialog.js";

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});

const createRebindToken = vi.fn();
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, createRebindToken: (...args: unknown[]) => createRebindToken(...args) };
});

const machine = {
  id: "11111111-1111-4111-8111-111111111111",
  hostname: "web01",
  displayName: null,
  os: "linux" as const,
  status: "active" as const,
};

const created: CreatedRebindToken = {
  id: "t-1",
  profile: "server",
  displayName: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  expiresAt: "2026-11-05T11:00:00.000Z",
  state: "valid",
  usedByEndpointId: null,
  kind: "rebind",
  purpose: "reinstall",
  endpointId: machine.id,
  endpointName: "web01",
  unrevoke: false,
  token: `rset_${"A".repeat(43)}`,
  os: "linux",
  instanceUrl: "https://restow.firma.de",
  commands: {
    install: "curl -fsSL 'https://restow.firma.de/install/linux.sh' | sudo sh",
    installUnattended: "x",
    tokenFile: "/root/restow-enrollment.token",
    uninstallScript: "x",
    uninstallAgent: "x",
    hooksScripts: "x",
    hooksAny: "x",
  },
  warnings: [],
};

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("the rebind dialog (docs/BAREMETAL.md 11)", () => {
  let page: Mounted;
  beforeEach(() => createRebindToken.mockReset());
  afterEach(() => page?.unmount());

  it("warns first, offers an hour, then shows the token once with the install command", async () => {
    createRebindToken.mockResolvedValue(created);
    page = mount();
    await page.render(
      <RebindDialog machine={machine} purpose="reinstall" open onOpenChange={() => undefined} />,
    );
    const warning = document.querySelector('[data-slot="rebind-warning"]')?.textContent ?? "";
    expect(warning).toContain("lasting access like an installed agent");
    expect(warning).toContain("loses its connection");
    expect(document.querySelector("#rebind-validity")?.textContent).toContain("1 hour");
    // An active machine is not offered to bring back.
    expect(document.querySelector('[data-slot="rebind-unrevoke"]')).toBeNull();
    await page.click(document.querySelector('[data-action="create-rebind"]') as Element);
    await page.settle();
    expect(createRebindToken).toHaveBeenCalledWith(machine.id, {
      purpose: "reinstall",
      validityHours: 1,
      unrevoke: false,
    });
    expect(document.querySelector('[data-slot="rebind-token"]')?.textContent).toContain(
      created.token,
    );
    expect(page.text()).toContain("/install/linux.sh");
  });

  it("brings a revoked machine back only when that is chosen", async () => {
    createRebindToken.mockResolvedValue({ ...created, unrevoke: true });
    page = mount();
    await page.render(
      <RebindDialog
        machine={{ ...machine, status: "revoked" }}
        purpose="baremetal"
        open
        onOpenChange={() => undefined}
      />,
    );
    expect(page.text()).toContain("without the option below, the token is refused");
    await page.click(document.querySelector("#rebind-unrevoke") as Element);
    await page.settle();
    await page.click(document.querySelector('[data-action="create-rebind"]') as Element);
    await page.settle();
    expect(createRebindToken).toHaveBeenCalledWith(machine.id, {
      purpose: "baremetal",
      validityHours: 1,
      unrevoke: true,
    });
  });
});
