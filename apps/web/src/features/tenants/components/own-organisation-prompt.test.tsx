// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type * as React from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";
import { type SessionContextValue, StaticSessionProvider } from "@/lib/session";

import "../i18n";
import type { OwnOrganisationPrompt as Prompt } from "../presenters";
import { OwnOrganisationPrompt } from "./own-organisation-prompt";

/**
 * The dashboard's question about the own organisation, mounted into a real
 * DOM: what it says for each situation, and that its two actions (create it,
 * or choose an existing tenant) send the requests the API expects, move the
 * session into the organisation and explain a refusal. Router links become
 * plain anchors; the dialogs render through a Radix portal onto `document.body`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      className,
      children,
    }: { to: string; search?: unknown; className?: string; children: React.ReactNode }) => (
      <a href={to} data-search={JSON.stringify(search ?? null)} className={className}>
        {children}
      </a>
    ),
  };
});

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

const setActiveTenant = vi.fn();

let container: HTMLDivElement;
let root: Root;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(prompt: Prompt, variant: "empty" | "banner" = "banner") {
  const session = { setActiveTenant } as unknown as SessionContextValue;
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <StaticSessionProvider value={session}>
            <OwnOrganisationPrompt prompt={prompt} variant={variant} />
          </StaticSessionProvider>
        </I18nextProvider>
      </QueryClientProvider>,
    );
    await flush();
  });
}

function buttons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")];
}

function button(text: string): HTMLButtonElement {
  const match = buttons().find((element) => element.textContent?.trim() === text);
  if (!match) {
    throw new Error(`expected a button with the text "${text}"`);
  }
  return match;
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
    await flush();
  });
}

async function type(selector: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement>(selector);
  if (!input) {
    throw new Error(`expected a control ${selector}`);
  }
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

const setUp = (overrides: Partial<Extract<Prompt, { kind: "setUp" }>> = {}): Prompt => ({
  kind: "setUp",
  canManage: true,
  canCreate: true,
  existing: [],
  ...overrides,
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  apiFetchMock.mockReset();
  setActiveTenant.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("what the prompt says", () => {
  it("asks to create the own organisation when no tenant exists, without offering a choice", async () => {
    await mount(setUp(), "empty");

    expect(document.body.textContent).toContain("Set up your own organisation");
    expect(document.body.textContent).toContain("Create it, then connect Microsoft 365 or IMAP");
    expect(button("Create own organisation")).toBeTruthy();
    expect(buttons().map((element) => element.textContent?.trim())).not.toContain(
      "Choose an existing one",
    );
  });

  it("offers choosing an existing tenant next to creating one where several tenants may exist", async () => {
    await mount(setUp({ existing: [{ id: "a", name: "Contoso", customerNumber: null }] }));

    expect(button("Create own organisation")).toBeTruthy();
    expect(button("Choose an existing one")).toBeTruthy();
  });

  it("offers only the choice where creating another tenant is not possible", async () => {
    await mount(
      setUp({ canCreate: false, existing: [{ id: "a", name: "Contoso", customerNumber: null }] }),
    );

    expect(buttons().map((element) => element.textContent?.trim())).not.toContain(
      "Create own organisation",
    );
    expect(button("Choose an existing one")).toBeTruthy();
  });

  it("tells whoever may not set it up instead of offering buttons that would be refused", async () => {
    await mount(setUp({ canManage: false }));

    expect(document.body.textContent).toContain("Only an administrator of the provider team");
    expect(buttons()).toHaveLength(0);
  });

  it("asks a service provider with an own organisation and no customer to add the first one", async () => {
    await mount({ kind: "addCustomer" });

    expect(document.body.textContent).toContain("Add your first customer");
    const link = document.body.querySelector("a");
    expect(link?.textContent).toContain("Add a customer");
    expect(link?.getAttribute("href")).toBe("/tenants");
    // The tenants page opens its wizard for this link.
    expect(JSON.parse(link?.getAttribute("data-search") ?? "null")).toEqual({ new: "1" });
  });
});

describe("creating the own organisation", () => {
  it("needs a name, sends it, moves the session into the new organisation and closes", async () => {
    apiFetchMock.mockResolvedValue({
      id: "own-1",
      name: "Acme IT",
      slug: "acme-it",
      kind: "internal",
      status: "active",
    });
    await mount(setUp());

    await click(button("Create own organisation"));
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    await click(button("Create"));
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("This field is required.");

    await type("#own-organisation-name", "  Acme IT  ");
    await click(button("Create"));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/tenants/internal",
      expect.objectContaining({ method: "POST", body: { name: "Acme IT" }, tenantId: null }),
    );
    expect(setActiveTenant).toHaveBeenCalledWith("own-1");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("explains a refusal and stays open", async () => {
    apiFetchMock.mockRejectedValue(
      new ApiError(
        409,
        {
          type: "urn:restow:problem:internal-tenant-exists",
          title: "Own organisation already exists",
          status: 409,
        },
        "x",
      ),
    );
    await mount(setUp());

    await click(button("Create own organisation"));
    await type("#own-organisation-name", "Acme IT");
    await click(button("Create"));

    expect(document.body.textContent).toContain(
      "Another organisation is already marked as your own.",
    );
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(setActiveTenant).not.toHaveBeenCalled();
  });
});

describe("choosing an existing tenant", () => {
  const existing = [
    { id: "a", name: "Contoso", customerNumber: "K-1001" },
    { id: "b", name: "Fabrikam", customerNumber: null },
  ];

  it("lists the tenants with their customer numbers and marks the one picked, nothing else", async () => {
    apiFetchMock.mockResolvedValue({
      id: "b",
      name: "Fabrikam",
      slug: "fabrikam",
      kind: "internal",
    });
    await mount(setUp({ existing }));

    await click(button("Choose an existing one"));
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Contoso");
    expect(dialog?.textContent).toContain("K-1001");
    expect(dialog?.textContent).toContain("Fabrikam");

    // Nothing is preselected among several, so nothing can be sent by accident.
    expect(button("Use as my own organisation").disabled).toBe(true);
    await click(document.body.querySelector('[role="radio"][id$="-b"]') as Element);
    expect(button("Use as my own organisation").disabled).toBe(false);
    await click(button("Use as my own organisation"));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/tenants/b/internal",
      expect.objectContaining({ method: "POST", tenantId: null }),
    );
    expect(setActiveTenant).toHaveBeenCalledWith("b");
  });

  it("preselects the only tenant there is", async () => {
    await mount(setUp({ existing: [existing[0] as (typeof existing)[number]] }));

    await click(button("Choose an existing one"));
    expect(button("Use as my own organisation").disabled).toBe(false);
  });
});
