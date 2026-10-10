// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { CreatedPveToken } from "./api";
import { ConnectDialog, existingTokenState } from "./connect-dialog";

/**
 * A real DOM mount of "Connect Proxmox VE" (react-dom/client + act): no
 * pveum block any more, one command per node with the enrollment token in it,
 * a new command for every further node, and the optional form for an existing
 * PVE API token whose values go to the API (and nowhere else).
 */

vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});

const createToken = vi.fn();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, createToken: (pveToken?: unknown) => createToken(pveToken) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const INSTANCE = "https://restow.example.test";

function created(n: number, pveTokenId: string | null = null): CreatedPveToken {
  const token = `rset_token${n}${"x".repeat(38)}`;
  return {
    id: `tok-${n}`,
    token,
    expiresAt: "2026-10-10T10:00:00.000Z",
    pveTokenId,
    nodeCommand: `curl -fsSL '${INSTANCE}/install/pve.sh' | RESTOW_ENROLL_TOKEN='${token}' sh`,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ConnectDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount() {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <ConnectDialog />
          </I18nextProvider>
        </QueryClientProvider>,
      );
      await flush();
    });
    await click(slot("pve-connect"));
  }

  const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  const all = (name: string) => [
    ...document.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
  ];
  const text = () => document.body.textContent ?? "";

  async function click(element: HTMLElement | null) {
    if (!element) throw new Error("element not found");
    await act(async () => {
      element.click();
      await flush();
      await flush();
    });
  }

  async function type(id: string, value: string) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) throw new Error(`#${id} not found`);
    await act(async () => {
      setValue(input, value);
      await flush();
    });
  }

  beforeEach(() => {
    let n = 0;
    createToken.mockImplementation((pveToken?: { id: string }) => {
      n += 1;
      return Promise.resolve(created(n, pveToken?.id ?? null));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows one command with the enrollment token in it and no pveum block", async () => {
    await mount();
    expect(text()).not.toContain("pveum");
    await click(slot("pve-create"));

    expect(createToken).toHaveBeenCalledWith(undefined);
    const commands = all("pve-command");
    expect(commands).toHaveLength(1);
    const command = commands[0]?.textContent ?? "";
    expect(command).toBe(created(1).nodeCommand);
    expect(command).toContain("RESTOW_ENROLL_TOKEN='rset_token1");
    expect(text()).not.toContain("pveum");
    expect(text()).not.toContain("--setup-pve-user");
    // Wraps instead of scrolling sideways, and has its own copy button.
    expect(commands[0]?.className).toContain("whitespace-pre-wrap");
    expect(commands[0]?.className).toContain("break-all");
    expect(commands[0]?.className).not.toContain("overflow-x");
    expect(
      slot("pve-commands")?.querySelectorAll('button[aria-label="Copy command"]'),
    ).toHaveLength(1);
    expect(slot("dialog-content")?.className).toContain("max-w-3xl");
  });

  it("makes a new command for every further node", async () => {
    await mount();
    await click(slot("pve-create"));
    await click(slot("pve-another"));
    await click(slot("pve-another"));

    expect(createToken).toHaveBeenCalledTimes(3);
    const commands = all("pve-command").map((c) => c.textContent);
    expect(commands).toEqual([
      created(1).nodeCommand,
      created(2).nodeCommand,
      created(3).nodeCommand,
    ]);
    expect(text()).toContain("Node 1");
    expect(text()).toContain("Node 3");
    expect(
      slot("pve-commands")?.querySelectorAll('button[aria-label="Copy command"]'),
    ).toHaveLength(3);
  });

  it("hands an existing PVE API token to the enrollment, also for the next node", async () => {
    await mount();
    expect(document.getElementById("pve-token-id")).toBeNull();
    await click(slot("pve-existing-toggle"));
    expect(document.getElementById("pve-token-id")).not.toBeNull();

    // Invalid input does not leave the dialog.
    await type("pve-token-id", "root@pam");
    await click(slot("pve-create"));
    expect(createToken).not.toHaveBeenCalled();
    expect(text()).toContain("Format: user@realm!name");
    expect(text()).toContain("The secret Proxmox VE showed once");

    // Another user than restow@pve is allowed, with a note.
    await type("pve-token-id", "backup@pve!restow");
    expect(slot("pve-token-unexpected")?.textContent).toContain("expects the user restow@pve");
    await type("pve-token-id", "restow@pve!restow");
    expect(slot("pve-token-unexpected")).toBeNull();
    await type("pve-token-secret", "9f1c2d3e-aaaa-4bbb-8ccc-0123456789ab");
    await click(slot("pve-create"));

    const sent = { id: "restow@pve!restow", secret: "9f1c2d3e-aaaa-4bbb-8ccc-0123456789ab" };
    expect(createToken).toHaveBeenCalledWith(sent);
    expect(slot("pve-uses-token")?.textContent).toContain(
      "This command uses the API token restow@pve!restow entered here.",
    );
    // The secret is never displayed.
    expect(text()).not.toContain(sent.secret);

    await click(slot("pve-another"));
    expect(createToken).toHaveBeenLastCalledWith(sent);
    expect(all("pve-command")).toHaveLength(2);

    // A way out when the entered token turns out unusable: the next command goes without it.
    await click(slot("pve-without-token"));
    expect(createToken).toHaveBeenLastCalledWith(undefined);
    expect(all("pve-command")).toHaveLength(3);
    expect(all("pve-uses-token")).toHaveLength(2);
    expect(slot("pve-without-token")).toBeNull();
    await click(slot("pve-another"));
    expect(createToken).toHaveBeenLastCalledWith(undefined);
  });
});

describe("existingTokenState", () => {
  it("accepts user@realm!name and notes another user than restow@pve", () => {
    expect(existingTokenState("restow@pve!restow", "9f1c2d3e-aaaa-4bbb-8ccc-0123456789ab")).toEqual(
      { idValid: true, secretValid: true, unexpectedUser: false },
    );
    expect(existingTokenState("root@pam!restow", "short").unexpectedUser).toBe(true);
    expect(existingTokenState("root@pam!restow", "short").secretValid).toBe(false);
    for (const bad of ["restow@pve", "restow!x", "restow@pve!", "restow@pve!1x", "a b@pve!x"]) {
      expect(existingTokenState(bad, "").idValid).toBe(false);
    }
  });
});
