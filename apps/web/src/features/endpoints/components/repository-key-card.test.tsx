// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { json, routedFetch } from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";

import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import { RepositoryKeyCard, exampleRestoreCommand } from "./repository-key-card.js";

vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return {
    ...actual,
    Dialog: { ...actual.Dialog, Portal: InPlacePortal },
    AlertDialog: { ...actual.AlertDialog, Portal: InPlacePortal },
  };
});

// The "Confirm it is you" step-up (components/confirm-identity-dialog.tsx) with a passkey.
const auth = vi.hoisted(() => ({
  passkey: vi.fn(),
  getSession: vi.fn(),
  listUserPasskeys: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { passkey: auth.passkey },
    getSession: auth.getSession,
    passkey: { listUserPasskeys: auth.listUserPasskeys },
  },
  browserSupportsPasskeys: () => true,
}));
vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    user: { id: "u1" },
    activeTenant: { id: "t-1", name: "Contoso" },
    refresh: auth.refresh,
    signOut: async () => undefined,
  }),
}));

const revealRepositoryPassword = vi.fn();
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return {
    ...actual,
    revealRepositoryPassword: (...args: unknown[]) => revealRepositoryPassword(...args),
  };
});

const ENDPOINT_ID = "11111111-1111-4111-8111-111111111111";
const PASSWORD = "correct-horse-battery-staple";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("the example command", () => {
  it("names the repository below the storage target", () => {
    expect(exampleRestoreCommand(`endpoints/${ENDPOINT_ID}`)).toBe(
      `restic -r /path/to/storage/endpoints/${ENDPOINT_ID} restore latest --target /restore`,
    );
    expect(exampleRestoreCommand(`/endpoints/${ENDPOINT_ID}/`)).toContain(
      `/path/to/storage/endpoints/${ENDPOINT_ID} restore`,
    );
  });
});

describe("RepositoryKeyCard", () => {
  let page: Mounted;

  beforeEach(() => {
    revealRepositoryPassword.mockReset();
    revealRepositoryPassword.mockResolvedValue({
      password: PASSWORD,
      storagePrefix: `endpoints/${ENDPOINT_ID}`,
    });
    auth.passkey.mockResolvedValue({ data: {}, error: null });
    auth.getSession.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    auth.listUserPasskeys.mockResolvedValue({ data: [{ id: "p1" }], error: null });
    auth.refresh.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /setup/state": () =>
          json({ passkeyReady: { ready: true, reasons: [], rpId: null, origin: null } }),
      }).mock,
    );
  });
  afterEach(() => {
    page?.unmount();
    vi.unstubAllGlobals();
  });

  async function open() {
    page = mount();
    await page.render(<RepositoryKeyCard endpointId={ENDPOINT_ID} />);
    await page.settle();
  }

  it("explains the feature and asks before it shows anything", async () => {
    await open();
    expect(page.text()).toContain("Restore without Restow");
    expect(page.text()).toContain("normal restic repository");
    expect(page.text()).not.toContain(PASSWORD);
    await page.click(page.byText("button", "Show repository password"));
    expect(page.text()).toContain("recorded in the audit log");
    expect(page.text()).toContain("decrypts the whole backup of this machine");
    // Asking is not enough: the password is fetched only after the confirmation.
    expect(revealRepositoryPassword).not.toHaveBeenCalled();
    expect(page.text()).not.toContain(PASSWORD);
  });

  it("shows the password once after the confirmation, with a copy button and an example command", async () => {
    await open();
    await page.click(page.byText("button", "Show repository password"));
    await page.click(page.byText("button", "Show password"));
    await page.settle();
    expect(revealRepositoryPassword).toHaveBeenCalledTimes(1);
    expect(revealRepositoryPassword).toHaveBeenCalledWith(ENDPOINT_ID);
    const shown = document.querySelector('[data-slot="repository-key-shown"]');
    expect(shown?.textContent).toContain(PASSWORD);
    expect(shown?.querySelector("code")?.className).toContain("font-mono");
    expect(
      shown?.querySelector('button[aria-label="Copy the repository password"]'),
    ).not.toBeNull();
    expect(shown?.textContent).toContain(
      `restic -r /path/to/storage/endpoints/${ENDPOINT_ID} restore latest --target /restore`,
    );
    expect(shown?.textContent).toContain("Not stored in this browser");
  });

  it("hides the password when the dialog closes and does not keep it in the cache", async () => {
    await open();
    await page.click(page.byText("button", "Show repository password"));
    await page.click(page.byText("button", "Show password"));
    await page.settle();
    expect(page.text()).toContain(PASSWORD);
    await page.click(page.byText("button", "Hide and close"));
    await page.settle();
    expect(page.text()).not.toContain(PASSWORD);
    const cached = JSON.stringify(
      page.queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.data ?? null),
    );
    expect(cached).not.toContain(PASSWORD);
    expect(
      JSON.stringify(
        page.queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data ?? null),
      ),
    ).not.toContain(PASSWORD);
    // Opening it again asks again; the earlier answer is gone.
    await page.click(page.byText("button", "Show repository password"));
    expect(page.text()).not.toContain(PASSWORD);
    expect(revealRepositoryPassword).toHaveBeenCalledTimes(1);
  });

  it("says why the password could not be shown and stays on the confirmation", async () => {
    revealRepositoryPassword.mockRejectedValue(
      new ApiError(
        409,
        { type: "urn:restow:problem:endpoint-repository-unavailable", title: "x", status: 409 },
        "x",
      ),
    );
    await open();
    await page.click(page.byText("button", "Show repository password"));
    await page.click(page.byText("button", "Show password"));
    await page.settle();
    expect(page.text()).toContain("could not be opened in the storage target");
    expect(page.text()).not.toContain(PASSWORD);
  });

  it("asks an older session to confirm it is them, then shows the password", async () => {
    revealRepositoryPassword.mockRejectedValueOnce(
      new ApiError(
        403,
        {
          type: "urn:restow:problem:recent-sign-in-required",
          title: "Confirm it is you",
          status: 403,
        },
        "Confirm it is you",
      ),
    );
    await open();
    await page.click(page.byText("button", "Show repository password"));
    expect(page.text()).toContain("If you signed in more than 10 minutes ago");
    await page.click(page.byText("button", "Show password"));
    await page.settle();
    expect(page.text()).toContain("Confirm it is you first");
    expect(page.text()).not.toContain(PASSWORD);
    expect(document.querySelector('[data-slot="confirm-identity"]')?.textContent).toContain(
      "Confirm it is you",
    );
    await page.settle();
    await page.click(page.byText("button", "Confirm with passkey"));
    await page.settle();
    await page.settle();
    expect(auth.passkey).toHaveBeenCalledTimes(1);
    // The password is asked for once more, with the fresh session, and shown.
    expect(revealRepositoryPassword).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-slot="confirm-identity"]')).toBeNull();
    expect(document.querySelector('[data-slot="repository-key-shown"]')?.textContent).toContain(
      PASSWORD,
    );
  });

  it("does not ask again when the confirmation is cancelled", async () => {
    revealRepositoryPassword.mockRejectedValue(
      new ApiError(
        403,
        {
          type: "urn:restow:problem:recent-sign-in-required",
          title: "Confirm it is you",
          status: 403,
        },
        "Confirm it is you",
      ),
    );
    await open();
    await page.click(page.byText("button", "Show repository password"));
    await page.click(page.byText("button", "Show password"));
    await page.settle();
    const confirm = document.querySelector('[data-slot="confirm-identity"]') as HTMLElement;
    const cancel = [...confirm.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Cancel",
    ) as HTMLElement;
    await page.click(cancel);
    await page.settle();
    expect(document.querySelector('[data-slot="confirm-identity"]')).toBeNull();
    expect(revealRepositoryPassword).toHaveBeenCalledTimes(1);
    expect(page.text()).not.toContain(PASSWORD);
  });

  it("can be switched off", async () => {
    page = mount();
    await page.render(<RepositoryKeyCard endpointId={ENDPOINT_ID} disabled />);
    expect((page.byText("button", "Show repository password") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
