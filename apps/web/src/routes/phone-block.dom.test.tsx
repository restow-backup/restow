// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ThemeProvider } from "@/components/theme-provider";
import { setPasswordRoute } from "@/features/accounts/route";
import { i18n } from "@/i18n";
import { queryKeys, type SetupState } from "@/lib/api";
import { PHONE_INPUT_QUERY } from "@/lib/device";
import { LoginPage } from "@/routes/login";
import { ResetPasswordPage } from "@/routes/reset-password";
import { appLayoutRoute, rootRoute } from "@/routes/tree";

/**
 * The phone block in a real DOM, through the real root and shell routes: the
 * sign-in and the app are replaced by the block page on a phone, the two mail
 * links keep working and end on a message instead of a sign-in, an invitation
 * gets its own text, and the public demo is left alone.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Recorded {
  method: string;
  path: string;
}
const server = vi.hoisted(() => ({ requests: [] as Recorded[] }));

// The better-auth client holds on to the fetch it found at import time, so the two calls the
// mail-link pages make through it are stood in for here and recorded like the others.
vi.mock("@/lib/auth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-client")>();
  const call = (path: string) => async () => {
    server.requests.push({ method: "POST", path });
    return { data: { token: "t", status: true }, error: null };
  };
  return {
    ...actual,
    authClient: new Proxy(actual.authClient, {
      get(target, property, receiver) {
        if (property === "resetPassword") {
          return call("/api/auth/reset-password");
        }
        if (property === "signIn") {
          return { email: call("/api/auth/sign-in/email") };
        }
        return Reflect.get(target, property, receiver);
      },
    }),
  };
});

const baseSetupState: SetupState = {
  configured: true,
  productName: "Restow",
  operatingMode: "public",
  publicUrl: "https://restow.example.test",
  passkeyReady: { ready: false, reasons: ["mode_not_public"], rpId: null, origin: null },
  mailTransport: "smtp",
  disclaimer: { version: "2026-09-30", accepted: true },
  setupToken: { required: false, source: null },
  microsoftSignIn: false,
  demo: { enabled: false, email: null, password: null },
};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>) =>
    z.object({ redirect: z.string().optional(), error: z.string().optional() }).parse(search),
  component: LoginPage,
});
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  validateSearch: (search: Record<string, unknown>) =>
    z.object({ token: z.string().optional() }).parse(search),
  component: ResetPasswordPage,
});
const invitationRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/invitations/$invitationId",
  component: () => <p data-slot="invitation-page">The invitation page</p>,
});
const homeRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/",
  component: () => <p data-slot="home-page">The app</p>,
});
const routeTree = rootRoute.addChildren([
  loginRoute,
  resetPasswordRoute,
  setPasswordRoute,
  appLayoutRoute.addChildren([invitationRoute, homeRoute]),
]);

// --- The device -------------------------------------------------------------------

const PHONE = { touch: true, screen: { width: 390, height: 844 } } as const;
const DESKTOP = { touch: false, screen: { width: 1920, height: 1080 } } as const;

let touch = true;
const mediaListeners = new Set<() => void>();

function setDevice(device: { touch: boolean; screen: { width: number; height: number } }) {
  touch = device.touch;
  vi.stubGlobal("screen", device.screen);
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return query === PHONE_INPUT_QUERY && touch;
    },
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
    addListener: (listener: () => void) => mediaListeners.add(listener),
    removeListener: (listener: () => void) => mediaListeners.delete(listener),
  }));
}

// --- The server -------------------------------------------------------------------

function respond(path: string, method: string): Response {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (method === "GET" && path.startsWith("/api/v1/accounts/set-password/")) {
    return json({ status: "valid", emailHint: "a***@example.test" });
  }
  if (method === "POST" && path === "/api/v1/accounts/set-password") {
    return json({ userId: "u1", email: "alex@example.test" });
  }
  return json({ message: "unrouted" }, 404);
}

// --- Mounting ---------------------------------------------------------------------

let root: Root | null = null;
let host: HTMLElement | null = null;
let router: ReturnType<typeof makeRouter>;

function makeRouter(queryClient: QueryClient, entry: string) {
  return createRouter({
    routeTree,
    context: { queryClient, navItems: [] },
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await tick();
    });
  }
}

async function open(entry: string, options: { demo?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.setupState, {
    ...baseSetupState,
    demo: { enabled: options.demo === true, email: null, password: null },
  });
  queryClient.setQueryData(queryKeys.authSession, null);
  router = makeRouter(queryClient, entry);
  await router.load();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </ThemeProvider>
      </I18nextProvider>,
    );
    await tick();
  });
  await settle();
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  server.requests = [];
  mediaListeners.clear();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    server.requests.push({ method, path: url.pathname });
    return respond(url.pathname, method);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

const text = () => document.body.textContent ?? "";
const block = () => document.querySelector<HTMLElement>('[data-slot="phone-block"]');
const heading = () => document.querySelector<HTMLElement>("h1");
const copyButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    /copy link|link copied/i.test(button.textContent ?? ""),
  ) ?? null;

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function choosePassword(scope: ParentNode, password: string) {
  const fields = [...scope.querySelectorAll<HTMLInputElement>("input[autocomplete=new-password]")];
  expect(fields).toHaveLength(2);
  await act(async () => {
    for (const field of fields) {
      setValue(field, password);
    }
    await tick();
  });
  await act(async () => {
    scope.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await tick();
  });
  await settle();
}

// --- The block page ---------------------------------------------------------------

describe("the block page on a phone", () => {
  it("replaces the sign-in, with one focused heading and the address to copy", async () => {
    setDevice(PHONE);
    await open("/login");

    expect(block()).not.toBeNull();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(heading()?.textContent).toBe("Restow is not available on phones");
    expect(document.activeElement).toBe(heading());
    // The sign-in form is not rendered at all, so no password field can be reached.
    expect(document.querySelector("input[type=password], input[type=email]")).toBeNull();
    expect(document.querySelector("form")).toBeNull();
    // The frame stays: language and theme can still be changed.
    expect(document.querySelector("main#main")).not.toBeNull();
    expect(block()?.textContent).toContain(`${window.location.origin}/login`);
    // No way past it: no "continue anyway" and no link into the app.
    expect(block()?.querySelectorAll("a")).toHaveLength(0);
    expect(block()?.querySelectorAll("button")).toHaveLength(1);
  });

  it("keeps the address where it was and has 44 px touch targets", async () => {
    setDevice(PHONE);
    await open("/login");
    expect(router.state.location.pathname).toBe("/login");
    expect(copyButton()?.className).toContain("min-h-11");
    // The language and theme switches in the frame are 44 px too, not 36 px.
    const switches = [...document.querySelectorAll("header button")];
    expect(switches).toHaveLength(2);
    expect(document.querySelector("header div.flex.items-center.gap-1")?.className).toContain(
      "[&_button]:size-11",
    );
  });

  it("copies the link for a computer", async () => {
    setDevice(PHONE);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await open("/login");
    await act(async () => {
      copyButton()?.click();
      await tick();
    });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/login`);
    expect(copyButton()?.textContent).toContain("Link copied");
  });

  it("says in German with the formal address", async () => {
    await i18n.changeLanguage("de");
    try {
      setDevice(PHONE);
      await open("/login");
      expect(heading()?.textContent).toBe("Restow ist auf Smartphones nicht verfügbar");
      expect(text()).toContain("Link kopieren");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("blocks the app shell as well", async () => {
    setDevice(PHONE);
    await open("/");
    // Without a session the shell sends to the sign-in; both end on the block page.
    expect(block()).not.toBeNull();
    expect(document.querySelector('[data-slot="home-page"]')).toBeNull();
  });

  it("appears and disappears when the input device changes", async () => {
    setDevice(PHONE);
    await open("/login");
    expect(block()).not.toBeNull();

    touch = false;
    await act(async () => {
      for (const listener of mediaListeners) {
        listener();
      }
      await tick();
    });
    expect(block()).toBeNull();
    expect(document.querySelector("input[type=password]")).not.toBeNull();
  });
});

describe("off a phone", () => {
  it("shows the sign-in on a desktop", async () => {
    setDevice(DESKTOP);
    await open("/login");
    expect(block()).toBeNull();
    expect(document.querySelector("input[type=password]")).not.toBeNull();
  });

  it("shows the sign-in on a tablet", async () => {
    setDevice({ touch: true, screen: { width: 820, height: 1180 } });
    await open("/login");
    expect(block()).toBeNull();
    expect(document.querySelector("input[type=password]")).not.toBeNull();
  });

  it("leaves the public demo alone, also on a phone", async () => {
    setDevice(PHONE);
    await open("/login", { demo: true });
    expect(block()).toBeNull();
    expect(document.querySelector("input[type=password]")).not.toBeNull();
  });
});

// --- The mail links ---------------------------------------------------------------

describe("set-password on a phone", () => {
  it("renders, sets the password and ends on a message without entering the app", async () => {
    setDevice(PHONE);
    await open("/accounts/set-password/tok_1");

    expect(block()).toBeNull();
    const form = document.querySelector("form");
    expect(form).not.toBeNull();

    await choosePassword(document.body, "a long enough password 42");

    expect(server.requests).toContainEqual({
      method: "POST",
      path: "/api/v1/accounts/set-password",
    });
    // No sign-in with the new password, no navigation into the app.
    expect(server.requests.some((request) => request.path.includes("/auth/"))).toBe(false);
    expect(router.state.location.pathname).toBe("/accounts/set-password/tok_1");
    expect(text()).toContain("Password set");
    expect(text()).toContain("Sign in on a computer.");
    // The result takes focus, so a screen reader announces it.
    expect(document.activeElement?.textContent).toBe("Password set");
    expect(
      [...document.querySelectorAll("button")].some((button) =>
        /^sign in$/i.test(button.textContent ?? ""),
      ),
    ).toBe(false);
  });

  it("says in German where to sign in", async () => {
    await i18n.changeLanguage("de");
    try {
      setDevice(PHONE);
      await open("/accounts/set-password/tok_1");
      await choosePassword(document.body, "ein langes Passwort 42");
      expect(text()).toContain("Passwort gesetzt");
      expect(text()).toContain("Melden Sie sich am Computer an.");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("still signs in and enters the app on a computer", async () => {
    setDevice(DESKTOP);
    await open("/accounts/set-password/tok_1");
    await choosePassword(document.body, "a long enough password 42");
    expect(server.requests).toContainEqual({ method: "POST", path: "/api/auth/sign-in/email" });
  });
});

describe("reset-password on a phone", () => {
  it("renders, saves the password and ends on a message with no sign-in button", async () => {
    setDevice(PHONE);
    await open("/reset-password?token=abc");

    expect(block()).toBeNull();
    await choosePassword(document.body, "a long enough password 42");

    expect(server.requests).toContainEqual({ method: "POST", path: "/api/auth/reset-password" });
    expect(router.state.location.pathname).toBe("/reset-password");
    const result = document.querySelector('[data-slot="reset-password-result"]');
    expect(result?.textContent).toContain("Password changed");
    expect(result?.textContent).toContain("Sign in on a computer");
    expect(result?.querySelector("button")).toBeNull();
    // The result takes focus, so a screen reader announces it.
    expect(document.activeElement?.textContent).toBe("Password changed");
  });

  it("keeps the sign-in button on a computer", async () => {
    setDevice(DESKTOP);
    await open("/reset-password?token=abc");
    await choosePassword(document.body, "a long enough password 42");
    const result = document.querySelector('[data-slot="reset-password-result"]');
    expect(result?.querySelector("button")).not.toBeNull();
  });
});

// --- The invitation ---------------------------------------------------------------

describe("an invitation on a phone", () => {
  it("shows its own text and copies the invitation link", async () => {
    setDevice(PHONE);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    // Without a session the shell sends the invitation to the sign-in page; the block knows.
    await open("/invitations/inv_1");

    expect(router.state.location.pathname).toBe("/login");
    expect(block()).not.toBeNull();
    expect(heading()?.textContent).toBe("Open this invitation on a computer");
    expect(text()).toContain("Accepting an invitation needs a sign-in");
    expect(document.querySelector('[data-slot="invitation-page"]')).toBeNull();

    await act(async () => {
      copyButton()?.click();
      await tick();
    });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/invitations/inv_1`);
  });

  it("is a normal sign-in redirect for a plain login page", async () => {
    setDevice(PHONE);
    await open("/login?redirect=%2Ftenants");
    expect(heading()?.textContent).toBe("Restow is not available on phones");
  });
});
