// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import { BaremetalWizardPage } from "./baremetal-wizard.js";

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));
vi.mock("@/routes/not-found", () => ({
  NotFoundPage: () => <p data-slot="not-found">not found</p>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
// The live view itself has its own suite; here it only has to be there.
vi.mock("./recovery-live.js", () => ({
  RecoveryLive: ({ recoveryId }: { recoveryId: string }) => (
    <div data-slot="recovery-live-card" data-recovery={recoveryId} />
  ),
}));

const ID = "11111111-1111-4111-8111-111111111111";
const RECOVERY = "22222222-2222-4222-8222-222222222222";
const recoveries = vi.fn();
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return {
    ...actual,
    fetchEndpoint: async () => ({ id: ID, hostname: "web01", displayName: null, os: "linux" }),
    // The preview was switched off after the code was redeemed.
    fetchBaremetal: async () => ({
      preview: false,
      enabled: true,
      state: "unverified",
      stateDetail: null,
      notPossible: null,
      latest: null,
      snapshotHint: null,
      check: null,
    }),
    fetchRecoveryIso: async () => ({
      version: null,
      fileName: null,
      url: null,
      sha256: null,
      releaseKeyFingerprint: null,
      verified: false,
      commands: { linux: [], macos: [], windows: [] },
    }),
    fetchRecoveries: () => recoveries(),
  };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("the bare metal page once a restore is no longer offered", () => {
  let page: Mounted;
  afterEach(() => page?.unmount());

  it("still shows the open session, so it can be released, ended or revoked", async () => {
    recoveries.mockResolvedValue([{ id: RECOVERY, status: "pending_approval" }]);
    page = mount();
    await page.render(<BaremetalWizardPage endpointId={ID} />);
    await page.settle();
    expect(document.querySelector('[data-slot="not-found"]')).toBeNull();
    expect(
      document.querySelector('[data-slot="recovery-live-card"]')?.getAttribute("data-recovery"),
    ).toBe(RECOVERY);
    // Nothing new can be issued from here.
    expect(document.querySelector('[data-action="open-recovery-code"]')).toBeNull();
  });

  it("is not found without an open code or session", async () => {
    recoveries.mockResolvedValue([{ id: RECOVERY, status: "succeeded" }]);
    page = mount();
    await page.render(<BaremetalWizardPage endpointId={ID} />);
    await page.settle();
    expect(document.querySelector('[data-slot="not-found"]')).not.toBeNull();
  });
});
