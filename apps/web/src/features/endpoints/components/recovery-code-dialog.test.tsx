// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { IssuedRecoveryCode } from "../api.js";
import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import { suggestedValidityHours } from "../presenters.js";
import { IssuedCodeView, RecoveryCodeDialog, typedAddress } from "./recovery-code-dialog.js";

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));
// Dialogs render in place, so no portal target is needed.
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});

const issueRecoveryCode = vi.fn();
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, issueRecoveryCode: (...args: unknown[]) => issueRecoveryCode(...args) };
});

const ID = "11111111-1111-4111-8111-111111111111";

function issued(over: Partial<IssuedRecoveryCode> = {}): IssuedRecoveryCode {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    code: "RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS",
    expiresAt: "2026-11-05T14:00:00.000Z",
    instanceOrigin: "https://restow.firma.de",
    instanceOriginConfigured: true,
    spkiCheck: "T6DN-BAMI-JR6W-LGRP",
    snapshotId: "a".repeat(64),
    requireApproval: true,
    iso: { version: "0.5.0", url: null, sha256: null, verified: true },
    ...over,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("the recovery code dialog (docs/BAREMETAL.md 9.2, 14.6)", () => {
  let page: Mounted;
  beforeEach(() => issueRecoveryCode.mockReset());
  afterEach(() => page?.unmount());

  it("suggests the validity from the data at 50 MB/s, at least 4 hours, at most 48", () => {
    expect(suggestedValidityHours(null)).toBe(4);
    expect(suggestedValidityHours(10 * 1000 ** 3)).toBe(4);
    // 1 TB: 5.6 hours at 50 MB/s, twice that is 11.1: the next choice is 12.
    expect(suggestedValidityHours(1000 ** 4)).toBe(12);
    expect(suggestedValidityHours(50 * 1000 ** 4)).toBe(48);
    expect(typedAddress("https://restow.firma.de:8443")).toBe("restow.firma.de:8443");
    expect(typedAddress("http://lab.local")).toBe("http://lab.local");
  });

  it("shows the code once in groups, the address to type, the check value and the read access", async () => {
    page = mount();
    await page.render(<IssuedCodeView issued={issued()} machineName="web01" />);
    const code = document.querySelector('[data-slot="recovery-code"]')?.textContent;
    expect(code).toBe("RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS");
    expect(document.querySelector('[data-slot="recovery-address"]')?.textContent).toBe(
      "restow.firma.de",
    );
    expect(document.querySelector('[data-slot="recovery-spki"]')?.textContent).toBe(
      "T6DN-BAMI-JR6W-LGRP",
    );
    const text = page.text();
    expect(text).toContain("exactly like this");
    expect(text).toContain("read access to every backup of this machine");
    expect(text).toContain("shown only now");
    expect(document.querySelector('[data-warning="browser-origin"]')).toBeNull();
    expect(text).not.toContain("rset_");
  });

  it("warns about an address from the browser and a missing check value", async () => {
    page = mount();
    await page.render(
      <IssuedCodeView
        issued={issued({ instanceOriginConfigured: false, spkiCheck: null })}
        machineName="web01"
      />,
    );
    expect(document.querySelector('[data-warning="browser-origin"]')?.textContent).toContain(
      "comes from your browser",
    );
    expect(document.querySelector('[data-slot="recovery-spki"]')?.textContent).toContain(
      "needs a certificate it trusts",
    );
  });

  it("issues with the release on and the suggested validity, then shows the code", async () => {
    issueRecoveryCode.mockResolvedValue(issued());
    const onIssued = vi.fn();
    page = mount();
    await page.render(
      <RecoveryCodeDialog
        endpointId={ID}
        machineName="web01"
        snapshotId={"a".repeat(64)}
        restoreBytes={1000 ** 4}
        open
        onOpenChange={() => undefined}
        onIssued={onIssued}
      />,
    );
    expect(document.querySelector('[data-slot="recovery-validity-suggestion"]')?.textContent).toBe(
      "Suggested: 12 hours, from the data to restore at about 50 MB/s.",
    );
    // No rebind token in this dialog.
    expect(page.text()).not.toContain("Reconnect");
    await page.click(document.querySelector('[data-action="issue-code"]') as Element);
    await page.settle();
    expect(issueRecoveryCode).toHaveBeenCalledWith(ID, {
      validityHours: 12,
      requireApproval: true,
      snapshotId: "a".repeat(64),
    });
    expect(onIssued).toHaveBeenCalled();
    expect(document.querySelector('[data-slot="recovery-code"]')?.textContent).toBe(
      "RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS",
    );
  });

  it("asks before the release is switched off", async () => {
    page = mount();
    await page.render(
      <RecoveryCodeDialog
        endpointId={ID}
        machineName="web01"
        open
        onOpenChange={() => undefined}
      />,
    );
    const toggle = document.querySelector("#recovery-require-approval") as Element;
    await page.click(toggle);
    await page.settle();
    expect(page.text()).toContain("Issue the code without a release?");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});
