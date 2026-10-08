// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { PasswordCard } from "./password-card";
import { SessionsCard } from "./sessions-card";

/**
 * Account › Sign-in security: changing the own password (the current one is
 * checked, other sessions may be signed out) and the list of the own
 * sessions with signing out a single one.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const changePassword = vi.fn();
const listSessions = vi.fn();
const revokeSession = vi.fn();
vi.mock("@/lib/auth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-client")>();
  return {
    ...actual,
    authClient: {
      ...actual.authClient,
      changePassword: (input: unknown) => changePassword(input),
      listSessions: () => listSessions(),
      revokeSession: (input: unknown) => revokeSession(input),
      revokeOtherSessions: () => Promise.resolve({ data: null, error: null }),
      useSession: () => ({ data: { session: { token: "current-token" } } }),
    },
  };
});

// Dialogs render in place, so no portal target is needed.
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return {
    ...actual,
    Dialog: { ...actual.Dialog, Portal: InPlacePortal },
    AlertDialog: { ...actual.AlertDialog, Portal: InPlacePortal },
  };
});

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  return host;
}

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) {
    throw new Error(`no button ${text}`);
  }
  return found;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
  });
  await settle();
}

async function type(selector: string, value: string): Promise<void> {
  const field = document.body.querySelector(selector) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitPasswordForm(): Promise<void> {
  await act(async () => {
    document.body
      .querySelector('[data-slot="change-password-form"]')
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  changePassword.mockReset();
  listSessions.mockReset();
  revokeSession.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

describe("changing the own password", () => {
  it("sends the current and the new password, signing the other sessions out by default", async () => {
    changePassword.mockResolvedValue({ data: { token: "t" }, error: null });
    await mount(<PasswordCard />);
    await click(button("Change password"));
    await type("#change-password-current", "the-current-one");
    await type("#change-password-new", "a-brand-new-password");
    await type("#change-password-confirm", "a-brand-new-password");
    await submitPasswordForm();
    expect(changePassword).toHaveBeenCalledWith({
      currentPassword: "the-current-one",
      newPassword: "a-brand-new-password",
      revokeOtherSessions: true,
    });
    expect(document.body.querySelector('[data-slot="change-password-form"]')).toBeNull();
  });

  it("checks the entries before asking the server", async () => {
    await mount(<PasswordCard />);
    await click(button("Change password"));
    await type("#change-password-current", "the-current-one");
    await type("#change-password-new", "short");
    await type("#change-password-confirm", "different");
    await submitPasswordForm();
    expect(changePassword).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("At least 12 characters");
  });

  it("says that the current password is wrong and keeps the dialog open", async () => {
    changePassword.mockResolvedValue({
      data: null,
      error: { status: 400, code: "INVALID_PASSWORD" },
    });
    await mount(<PasswordCard />);
    await click(button("Change password"));
    await type("#change-password-current", "not-the-password");
    await type("#change-password-new", "a-brand-new-password");
    await type("#change-password-confirm", "a-brand-new-password");
    await submitPasswordForm();
    expect(document.body.textContent).toContain("The current password is wrong.");
    expect(document.body.querySelector('[data-slot="change-password-form"]')).not.toBeNull();
  });
});

describe("the own sessions", () => {
  const sessions = [
    {
      id: "s-1",
      token: "current-token",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 Safari/605",
      ipAddress: "203.0.113.5",
      createdAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-07T08:00:00.000Z",
    },
    {
      id: "s-2",
      token: "other-token",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/131.0",
      ipAddress: "198.51.100.7",
      createdAt: "2026-10-02T08:00:00.000Z",
      updatedAt: "2026-10-06T08:00:00.000Z",
    },
  ];

  it("lists every browser, this one marked, and signs out a single other one", async () => {
    listSessions.mockResolvedValue({ data: sessions, error: null });
    revokeSession.mockResolvedValue({ data: { status: true }, error: null });
    await mount(<SessionsCard />);
    const rows = [...document.body.querySelectorAll('[data-slot="session"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-current")).toBe("true");
    expect(rows[0]?.textContent).toContain("This browser");
    expect(rows[0]?.textContent).toContain("Safari on Mac");
    expect(rows[1]?.textContent).toContain("Firefox on Windows");
    expect(rows[1]?.textContent).toContain("IP 198.51.100.7");
    // Only the other session has a sign-out button of its own.
    expect(rows[0]?.querySelector("button")).toBeNull();

    await click(rows[1]?.querySelector("button") as HTMLButtonElement);
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("Firefox on Windows");
    const confirm = [...dialog.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Sign out",
    ) as HTMLButtonElement;
    await click(confirm);
    expect(revokeSession).toHaveBeenCalledWith({ token: "other-token" });
  });

  it("offers no sign-out of others when this browser is the only session", async () => {
    listSessions.mockResolvedValue({ data: [sessions[0]], error: null });
    await mount(<SessionsCard />);
    expect(button("Sign out other sessions").disabled).toBe(true);
  });
});
