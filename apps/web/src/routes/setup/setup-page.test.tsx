// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type * as React from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/components/theme-provider";
import { i18n } from "@/i18n";
import { type SetupState, queryKeys } from "@/lib/api";

import { SetupPage } from "./index";

/**
 * The wizard's first two steps, driven with real DOM events through the real
 * page: the setup token is checked on the server before anything else shows,
 * a wrong one is refused in place, and the operator responsibility notice
 * keeps Continue disabled until the box is ticked and sends nothing itself.
 * The setup request carries the token as a header and the acceptance in its
 * body; a token that changed in between (the api restarted) leads back to the
 * first step. The server's own refusals are proven in apps/api
 * (routes/setup.pg.test.ts).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children?: React.ReactNode;
      className?: string;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

const VERSION = "2026-09-30";

const freshState: SetupState = {
  configured: false,
  productName: "Restow",
  operatingMode: null,
  publicUrl: null,
  passkeyReady: { ready: false, reasons: ["mode_not_public"], rpId: null, origin: null },
  mailTransport: null,
  disclaimer: { version: VERSION, accepted: false },
  setupToken: { required: true, source: "log" },
  microsoftSignIn: false,
  demo: { enabled: false, email: null, password: null },
};

/** The demo: no setup token, the notice counts as accepted. */
const demoState: SetupState = {
  ...freshState,
  disclaimer: { version: VERSION, accepted: true },
  setupToken: { required: false, source: null },
  demo: { enabled: true, email: "demo@example.com", password: "demo" },
};

const TOKEN = "K7PQX-3MZRA-T9WHE-2BNCV";

const fetchMock = vi.fn();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let container: HTMLDivElement;
let root: Root;

async function mount(state: SetupState): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.setupState, state);
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <SetupPage />
          </QueryClientProvider>
        </ThemeProvider>
      </I18nextProvider>,
    );
    await flush();
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
    await flush();
  });
}

function checkbox(): HTMLButtonElement {
  const box = container.querySelector<HTMLButtonElement>('[role="checkbox"]');
  if (!box) {
    throw new Error("expected the notice checkbox");
  }
  return box;
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) {
    throw new Error(`expected a button labelled "${label}"`);
  }
  return match;
}

/** Type into a form control the way a person does (React sees an input event). */
async function type(id: string, value: string): Promise<void> {
  const element = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!element) {
    throw new Error(`expected a control #${id}`);
  }
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

/** Enter the token and get past the first step (the server answers 204). */
async function passTokenStep(): Promise<void> {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await type("setup-token", TOKEN);
  await click(button("Next"));
}

/** The requests the page sent, as "METHOD /path". */
function requests(): string[] {
  return fetchMock.mock.calls.map(([url, init]) => {
    const path = String(url).replace(/^.*\/api\/v1/, "");
    return `${(init as RequestInit | undefined)?.method ?? "GET"} ${path}`;
  });
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  navigateSpy.mockReset();
});

describe("setup wizard, setup token step", () => {
  it("starts with the setup token and says where to find it", async () => {
    await mount(freshState);

    expect(container.textContent).toContain("Step 1 of 6");
    expect(container.textContent).toContain("Confirm that you run this server");
    expect(container.textContent).toContain("docker compose logs api | grep 'SETUP TOKEN'");
    // Neither the notice nor the operating mode is reachable yet.
    expect(container.textContent).not.toContain("Your responsibility as operator");
    expect(container.textContent).not.toContain("How do you run Restow?");
  });

  it("points at RESTOW_SETUP_TOKEN when the server takes the token from its environment", async () => {
    await mount({ ...freshState, setupToken: { required: true, source: "environment" } });

    expect(container.textContent).toContain("RESTOW_SETUP_TOKEN");
    expect(container.textContent).not.toContain("docker compose logs api");
  });

  it("asks for a token before sending anything", async () => {
    await mount(freshState);

    await click(button("Next"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter the setup token.");
    expect(container.textContent).toContain("Step 1 of 6");
  });

  it("stays on the step when the server refuses the token", async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, {
        type: "urn:restow:problem:setup-token-invalid",
        title: "Setup token required",
        status: 403,
      }),
    );
    await mount(freshState);

    await type("setup-token", "WRONG-TOKEN");
    await click(button("Next"));

    expect(requests()).toEqual(["POST /setup/token"]);
    const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("x-restow-setup-token")).toBe("WRONG-TOKEN");
    expect(container.textContent).toContain("This is not the setup token of this server.");
    expect(container.textContent).toContain("Step 1 of 6");
  });

  it("moves on to the notice once the server accepts the token", async () => {
    await mount(freshState);

    await passTokenStep();

    expect(requests()).toEqual(["POST /setup/token"]);
    expect(container.textContent).toContain("Step 2 of 6");
    expect(container.textContent).toContain("Your responsibility as operator");
  });

  it("skips the token in the demo, which has none, and the notice, which counts as accepted", async () => {
    await mount(demoState);

    expect(container.textContent).toContain("Step 3 of 6");
    expect(container.textContent).toContain("How do you run Restow?");
  });
});

describe("setup wizard, operator notice step", () => {
  it("shows the notice in the operator's words and with the branded product name", async () => {
    await mount(freshState);
    await passTokenStep();

    expect(container.textContent).toContain("Your responsibility as operator");
    // The text speaks of the branded product name, not a hard-coded one.
    expect(container.textContent).toContain("Restow is a tool for backup and archiving");
    for (const point of [
      "No replacement for a backup strategy",
      "Hardware and storage",
      "Ransomware and deletion",
      "Encryption keys",
      "Network and access",
      "Test your restores",
      "Archive and GoBD",
      "No warranty",
    ]) {
      expect(container.textContent).toContain(point);
    }
    expect(container.textContent).toContain("designed for GoBD-compliant use");
    expect(container.textContent).toContain(`Version ${VERSION}`);
    // The operating mode is not reachable yet.
    expect(container.textContent).not.toContain("How do you run Restow?");
  });

  it("keeps Continue disabled until the box is ticked, and again when it is cleared", async () => {
    await mount(freshState);
    await passTokenStep();

    expect(checkbox().getAttribute("aria-checked")).toBe("false");
    expect(button("Continue").disabled).toBe(true);
    expect(container.textContent).toContain("Tick the box to continue.");

    await click(checkbox());
    expect(checkbox().getAttribute("aria-checked")).toBe("true");
    expect(button("Continue").disabled).toBe(false);

    await click(checkbox());
    expect(button("Continue").disabled).toBe(true);
  });

  it("moves on without a request of its own: the acceptance goes with the setup", async () => {
    await mount(freshState);
    await passTokenStep();

    await click(checkbox());
    await click(button("Continue"));

    expect(requests()).toEqual(["POST /setup/token"]);
    expect(container.textContent).toContain("Step 3 of 6");
    expect(container.textContent).toContain("How do you run Restow?");
  });
});

describe("setup wizard, finishing", () => {
  async function fillUpToReview(): Promise<void> {
    await mount(freshState);
    await passTokenStep();
    await click(checkbox());
    await click(button("Continue"));
    // Operating mode: local, the default.
    await click(button("Next"));
    await type("admin-name", "Operator");
    await type("admin-email", "ops@example.com");
    await type("admin-password", "correct-horse-battery-1");
    await type("admin-confirm", "correct-horse-battery-1");
    await click(button("Next"));
    await type("smtp-host", "mail.example.com");
    await type("smtp-from", "restow@example.com");
    await click(button("Next"));
    expect(container.textContent).toContain("Step 6 of 6");
  }

  it("sends the token as a header and the accepted notice in the body", async () => {
    await fillUpToReview();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      json(403, {
        type: "urn:restow:problem:setup-token-invalid",
        title: "Setup token required",
        status: 403,
      }),
    );

    await click(button("Finish setup"));

    expect(requests()).toEqual(["POST /setup"]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("x-restow-setup-token")).toBe(TOKEN);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.disclaimer).toEqual({ version: VERSION, accepted: true });
    expect(body.firstAdmin).toMatchObject({ email: "ops@example.com" });
  });

  it("goes back to the first step when the token changed in between, keeping the entries", async () => {
    await fillUpToReview();
    fetchMock.mockResolvedValueOnce(
      json(403, {
        type: "urn:restow:problem:setup-token-invalid",
        title: "Setup token required",
        status: 403,
      }),
    );

    await click(button("Finish setup"));

    expect(container.textContent).toContain("Step 1 of 6");
    expect(container.textContent).toContain("The setup token has changed");
    // Everything entered so far is still there.
    expect(container.querySelector<HTMLInputElement>("#setup-token")?.value).toBe(TOKEN);
    await passTokenStep();
    await click(button("Continue"));
    await click(button("Next"));
    expect(container.querySelector<HTMLInputElement>("#admin-email")?.value).toBe(
      "ops@example.com",
    );
    // Back on the review, the token problem is not shown again as a failed setup.
    await click(button("Next"));
    await click(button("Next"));
    expect(container.textContent).toContain("Step 6 of 6");
    expect(container.textContent).not.toContain("The setup could not be saved.");
  });

  it("goes back to the notice when the server moved on to a newer text", async () => {
    await fillUpToReview();
    fetchMock.mockResolvedValueOnce(
      json(409, {
        type: "urn:restow:problem:disclaimer-version-mismatch",
        title: "Operator notice changed",
        status: 409,
      }),
    );

    await click(button("Finish setup"));

    expect(container.textContent).toContain("Step 2 of 6");
    expect(container.textContent).toContain("The notice was updated. Reload the page");
    expect(button("Reload")).toBeTruthy();
    expect(checkbox().getAttribute("aria-checked")).toBe("false");
  });
});
