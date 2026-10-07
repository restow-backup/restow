// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { AccountsDialog } from "./accounts-dialog";
import "./i18n";
import type { CsvImportOutcome, DirectorySource, ImapAuthMode } from "./types";

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      className,
      children,
    }: { to: string; className?: string; children: React.ReactNode }) => (
      <a href={String(to)} className={className}>
        {children}
      </a>
    ),
  };
});

const importAccounts = vi.fn();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    importAccounts: (...args: unknown[]) => importAccounts(...args),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function source(mode: ImapAuthMode | null): DirectorySource {
  return {
    id: "s-imap-1",
    name: "Hoster",
    kind: "imap",
    status: "active",
    errorMessage: null,
    failure: null,
    lastSyncAt: null,
    consentGranted: true,
    rules: null,
    overrideCount: 0,
    sync: null,
    imapAuthMode: mode,
    counts: { total: 0, active: 0, excluded: 0, orphaned: 0, mailbox: 0, onedrive: 0, imap: 0 },
  };
}

function outcome(dryRun: boolean, hasPassword = false): CsvImportOutcome {
  return {
    created: 1,
    existing: 0,
    accounts: [
      {
        login: "anna@example.com",
        email: "anna@example.com",
        displayName: null,
        state: "new",
        hasPassword,
      },
    ],
    issues: [],
    dryRun,
    hasHeader: false,
    delimiter: ",",
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
    await flush();
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().startsWith(label),
  );
  expect(found, `button ${label}`).toBeDefined();
  return found as HTMLButtonElement;
}

describe("AccountsDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  function mount(mode: ImapAuthMode | null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <I18nextProvider i18n={i18n}>
            <AccountsDialog source={source(mode)} open onOpenChange={() => undefined} />
          </I18nextProvider>
        </QueryClientProvider>,
      );
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    importAccounts.mockReset();
  });

  it.each([
    ["shared", "one shared login"],
    ["per_mailbox", "one password per mailbox"],
    ["master_user", "master account"],
    [null, "one shared login"],
  ] as const)(
    "states the %s login mode in one sentence with a link to the source",
    (mode, text) => {
      mount(mode);
      const sentence = document.body.querySelector('[data-testid="accounts-mode"]');
      expect(sentence?.textContent).toContain(text);
      const link = [...document.body.querySelectorAll("a")].find(
        (a) => a.textContent === "Change mode",
      );
      expect(link).toBeDefined();
      expect(link?.getAttribute("href")).toContain("s-imap-1");
    },
  );

  it("shows per-mailbox username and password fields only in per-mailbox mode and submits them", async () => {
    importAccounts.mockImplementation(async (_s: string, _csv: string, dryRun: boolean) =>
      outcome(dryRun, !dryRun),
    );
    mount("per_mailbox");
    await type(
      document.body.querySelector("#accounts-text") as HTMLTextAreaElement,
      "anna@example.com",
    );
    await click(button("Check list"));
    const password = document.body.querySelector<HTMLInputElement>(
      "[id='accounts-password-anna@example.com']",
    );
    expect(password).not.toBeNull();
    expect(document.body.querySelector("[id='accounts-username-anna@example.com']")).not.toBeNull();
    await type(password as HTMLInputElement, "s3cret");
    await click(button("Add 1 account"));
    const [, csv, dryRun] = importAccounts.mock.calls.at(-1) as [string, string, boolean];
    expect(dryRun).toBe(false);
    expect(csv).toBe("login,name,email,password\nanna@example.com,,anna@example.com,s3cret");
    expect(document.body.querySelector('[data-testid="accounts-results"]')?.textContent).toContain(
      "Password set",
    );
  });

  it.each(["shared", "master_user"] as const)(
    "offers no password field in %s mode",
    async (mode) => {
      importAccounts.mockImplementation(async (_s: string, _csv: string, dryRun: boolean) =>
        outcome(dryRun),
      );
      mount(mode);
      await type(
        document.body.querySelector("#accounts-text") as HTMLTextAreaElement,
        "anna@example.com",
      );
      await click(button("Check list"));
      expect(document.body.querySelector('[data-testid="accounts-row-fields"]')).toBeNull();
      expect(document.body.querySelector("input[type='password']")).toBeNull();
      await click(button("Add 1 account"));
      expect(importAccounts.mock.calls.at(-1)?.[1]).toBe("anna@example.com");
    },
  );
});
