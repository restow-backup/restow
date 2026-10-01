// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import {
  type Mounted,
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  json,
  mount,
  routedFetch,
  sessionAs,
} from "@/features/updates/testing";

/**
 * The step-up dialog (lib/recent-sign-in.ts): a passkey confirms in place and
 * runs the action once, for the same account only; everyone else signs in again.
 */

const auth = vi.hoisted(() => ({
  passkey: vi.fn(),
  getSession: vi.fn(),
  listUserPasskeys: vi.fn(),
  supported: true,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { passkey: auth.passkey },
    getSession: auth.getSession,
    passkey: { listUserPasskeys: auth.listUserPasskeys },
  },
  browserSupportsPasskeys: () => auth.supported,
}));

const { useConfirmIdentity } = await import("./confirm-identity-dialog");

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function setupState(passkeyReady: boolean) {
  return {
    passkeyReady: { ready: passkeyReady, reasons: [], rpId: null, origin: null },
  };
}

function stubSetup(passkeyReady: boolean): void {
  vi.stubGlobal(
    "fetch",
    routedFetch({ "GET /setup/state": () => json(setupState(passkeyReady)) }).mock,
  );
}

beforeEach(() => {
  auth.supported = true;
  auth.passkey.mockResolvedValue({ data: {}, error: null });
  auth.getSession.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
  auth.listUserPasskeys.mockResolvedValue({ data: [{ id: "p1" }], error: null });
  stubSetup(true);
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function Harness({ action }: { action: () => void }) {
  const identity = useConfirmIdentity();
  return (
    <>
      <button type="button" onClick={() => identity.ask(action)}>
        Change
      </button>
      {identity.dialog}
    </>
  );
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-slot="confirm-identity"]');
}

describe("ConfirmIdentityDialog", () => {
  it("confirms with the passkey of the same account and repeats the action once", async () => {
    const action = vi.fn();
    const refresh = vi.fn(async () => undefined);
    mounted = mount(<Harness action={action} />, { session: sessionAs({ refresh }) });
    await click(buttonByText(document.body, "Change"));
    await flush(5);
    expect(dialog()?.textContent).toContain("Confirm it is you");
    await click(buttonByText(dialog() as HTMLElement, "Confirm with passkey"));
    await flush(5);
    expect(auth.passkey).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it("does not run the action when the passkey fails or is cancelled", async () => {
    auth.passkey.mockResolvedValue({
      data: null,
      error: { status: 400, statusText: "x", code: "AUTH_CANCELLED" },
    });
    const action = vi.fn();
    mounted = mount(<Harness action={action} />);
    await click(buttonByText(document.body, "Change"));
    await flush(5);
    await click(buttonByText(dialog() as HTMLElement, "Confirm with passkey"));
    await flush(5);
    expect(action).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("The passkey sign-in was cancelled.");
    await click(buttonByText(dialog() as HTMLElement, "Cancel"));
    await flush();
    expect(dialog()).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it("offers only signing in again without a usable passkey", async () => {
    for (const setup of [
      () => {
        auth.listUserPasskeys.mockResolvedValue({ data: [], error: null });
      },
      () => {
        auth.supported = false;
      },
      () => {
        stubSetup(false);
      },
    ]) {
      setup();
      mounted = mount(<Harness action={() => undefined} />);
      await click(buttonByText(document.body, "Change"));
      await flush(5);
      expect(buttonByText(dialog() as HTMLElement, "Confirm with passkey")).toBeNull();
      expect(buttonByText(dialog() as HTMLElement, "Sign in again")).not.toBeNull();
      await mounted.unmount();
      mounted = null;
      document.body.innerHTML = "";
      auth.supported = true;
      auth.listUserPasskeys.mockResolvedValue({ data: [{ id: "p1" }], error: null });
      stubSetup(true);
    }
  });

  it("signs out and returns to this page through the sign-in page", async () => {
    const signOut = vi.fn(async () => undefined);
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      pathname: "/settings/updates",
      search: "",
      assign,
    });
    mounted = mount(<Harness action={() => undefined} />, { session: sessionAs({ signOut }) });
    await click(buttonByText(document.body, "Change"));
    await flush(5);
    await click(buttonByText(dialog() as HTMLElement, "Sign in again"));
    await flush(5);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/login?redirect=%2Fsettings%2Fupdates");
  });
});
