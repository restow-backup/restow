// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/components/theme-provider";
import { i18n } from "@/i18n";

import { ForgotAccess } from "./forgot-access";
import { ResetPasswordPage, resetFailureOf } from "./reset-password";

/**
 * "Forgot your password or lost access?" on the login page and the page the
 * link of the reset mail opens: the form only where the installation can
 * mail, an answer that never tells whether the address has an account, the
 * ways back in when the authenticator app is gone too, and the new password
 * set with the token from the mail.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const requestPasswordReset = vi.fn();
const resetPassword = vi.fn();
vi.mock("@/lib/auth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-client")>();
  return {
    ...actual,
    authClient: {
      ...actual.authClient,
      requestPasswordReset: (input: unknown) => requestPasswordReset(input),
      resetPassword: (input: unknown) => resetPassword(input),
    },
  };
});

let search: Record<string, string> = {};
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useSearch: () => search,
  useNavigate: () => () => Promise.resolve(),
}));

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>{node}</ThemeProvider>
      </I18nextProvider>,
    );
  });
  await settle();
  return host;
}

async function type(input: Element | null, value: string): Promise<void> {
  const field = input as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: Element | null): Promise<void> {
  await act(async () => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  requestPasswordReset.mockReset();
  resetPassword.mockReset();
  search = {};
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("ForgotAccess", () => {
  it("sends the link and answers the same whatever the address", async () => {
    requestPasswordReset.mockResolvedValue({ data: { status: true }, error: null });
    const el = await mount(<ForgotAccess mailReset onBack={() => undefined} />);
    await type(el.querySelector("#forgot-email"), "someone@example.com");
    await submit(el.querySelector('[data-slot="forgot-form"]'));
    expect(requestPasswordReset).toHaveBeenCalledWith({ email: "someone@example.com" });
    const sent = el.querySelector('[data-slot="forgot-sent"]')?.textContent ?? "";
    expect(sent).toContain("If a matching account belongs to this address");
    expect(sent).toContain("Your authenticator app stays set up");
  });

  it("says that it is too many requests, without telling anything about the account", async () => {
    requestPasswordReset.mockResolvedValue({ data: null, error: { status: 429 } });
    const el = await mount(<ForgotAccess mailReset onBack={() => undefined} />);
    await type(el.querySelector("#forgot-email"), "someone@example.com");
    await submit(el.querySelector('[data-slot="forgot-form"]'));
    expect(el.textContent).toContain("Too many failed attempts");
    expect(el.querySelector('[data-slot="forgot-sent"]')).toBeNull();
  });

  it("offers no form without mail, and always the other ways back in", async () => {
    const el = await mount(<ForgotAccess mailReset={false} onBack={() => undefined} />);
    expect(el.querySelector('[data-slot="forgot-form"]')).toBeNull();
    expect(el.textContent).toContain("This installation cannot send mail");
    const lost = el.querySelector('[data-slot="forgot-lost"]')?.textContent ?? "";
    expect(lost).toContain("Installation › Members");
    expect(lost).toContain(
      "docker compose exec api restow admin recover --email owner@example.com",
    );
  });
});

describe("ResetPasswordPage", () => {
  it("sets the new password with the token from the mail", async () => {
    search = { token: "tok-123" };
    resetPassword.mockResolvedValue({ data: { status: true }, error: null });
    const el = await mount(<ResetPasswordPage />);
    await type(el.querySelector("#reset-password"), "a-new-password-1");
    await type(el.querySelector("#reset-password-confirm"), "a-new-password-1");
    await submit(el.querySelector('[data-slot="reset-password-form"]'));
    expect(resetPassword).toHaveBeenCalledWith({
      newPassword: "a-new-password-1",
      token: "tok-123",
    });
    expect(el.textContent).toContain("Password changed");
  });

  it("refuses two different entries before asking the server", async () => {
    search = { token: "tok-123" };
    const el = await mount(<ResetPasswordPage />);
    await type(el.querySelector("#reset-password"), "a-new-password-1");
    await type(el.querySelector("#reset-password-confirm"), "another-password-2");
    await submit(el.querySelector('[data-slot="reset-password-form"]'));
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("says plainly when the link is used, expired or missing", async () => {
    search = { token: "tok-used" };
    resetPassword.mockResolvedValue({ data: null, error: { status: 400, code: "INVALID_TOKEN" } });
    const el = await mount(<ResetPasswordPage />);
    await type(el.querySelector("#reset-password"), "a-new-password-1");
    await type(el.querySelector("#reset-password-confirm"), "a-new-password-1");
    await submit(el.querySelector('[data-slot="reset-password-form"]'));
    expect(el.textContent).toContain("This link no longer works");

    act(() => root?.unmount());
    host?.remove();
    search = {};
    const missing = await mount(<ResetPasswordPage />);
    expect(missing.textContent).toContain("This link no longer works");
    expect(missing.querySelector('[data-slot="reset-password-form"]')).toBeNull();
  });

  it("maps the answers of the server", () => {
    expect(resetFailureOf({ status: 400, code: "INVALID_TOKEN" })).toBe("invalidLink");
    expect(resetFailureOf({ status: 429 })).toBe("tooMany");
    expect(resetFailureOf({ status: 500 })).toBe("generic");
    expect(resetFailureOf(null)).toBe("generic");
  });
});
