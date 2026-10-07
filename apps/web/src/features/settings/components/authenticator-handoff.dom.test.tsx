// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import {
  clearPasswordHandoff,
  holdPasswordForEnrolment,
  peekPasswordForEnrolment,
} from "@/lib/password-handoff";

import { AuthenticatorSetup } from "./authenticator-setup";

/**
 * The mandatory enrolment right after the setup wizard, the set-password page
 * or a password sign-in starts with the password typed moments before
 * (lib/password-handoff.ts) instead of asking for it again; when that fails,
 * or nothing was handed over, it asks.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const enable = vi.fn();
vi.mock("@/lib/auth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-client")>();
  return {
    ...actual,
    authClient: {
      ...actual.authClient,
      twoFactor: { ...actual.authClient.twoFactor, enable: (input: unknown) => enable(input) },
    },
  };
});

const TOTP_URI =
  "otpauth://totp/Restow:admin%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Restow&digits=6&period=30";

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(mode: "enroll" | "replace"): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <AuthenticatorSetup mode={mode} onComplete={() => undefined} onCancel={() => undefined} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return host;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  enable.mockReset();
  clearPasswordHandoff();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("the enrolment after a password was just typed", () => {
  it("starts with the handed-over password and goes straight to the QR code", async () => {
    enable.mockResolvedValue({
      data: { totpURI: TOTP_URI, backupCodes: ["abcde-12345"] },
      error: null,
    });
    holdPasswordForEnrolment("just-typed-password");
    const el = await mount("enroll");
    expect(enable).toHaveBeenCalledWith({ password: "just-typed-password" });
    expect(el.textContent).toContain("Scan this QR code with the app.");
    expect(el.querySelector("#authenticator-password-field")).toBeNull();
    // Used once: nothing is held any more.
    expect(peekPasswordForEnrolment()).toBeNull();
  });

  it("asks once more, saying so, when the handed-over password does not work", async () => {
    enable.mockResolvedValue({ data: null, error: { status: 400, code: "INVALID_PASSWORD" } });
    holdPasswordForEnrolment("stale-password");
    const el = await mount("enroll");
    expect(enable).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("Please confirm your password once more");
    expect(el.querySelector("#authenticator-password-field")).not.toBeNull();
  });

  it("asks for the password when nothing was handed over", async () => {
    const el = await mount("enroll");
    expect(enable).not.toHaveBeenCalled();
    expect(el.textContent).toContain("Confirm with your password");
  });

  it("never uses a handed-over password to move to a new phone", async () => {
    holdPasswordForEnrolment("just-typed-password");
    const el = await mount("replace");
    expect(enable).not.toHaveBeenCalled();
    expect(el.textContent).toContain("Confirm with your password");
  });
});
