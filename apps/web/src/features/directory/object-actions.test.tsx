// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { type MockInstance, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import { RemoveBlockedDialog, SetCredentialDialog } from "./object-actions";
import type { ProtectedObject } from "./types";

/**
 * A real DOM mount of `SetCredentialDialog` (react-dom/client + act, the same
 * convention as tenant-wizard.test.tsx "interactive" suite; no React Testing
 * Library in this workspace). Rendered to static markup elsewhere in this
 * feature cannot catch this: the bug this guards against only shows up across
 * re-renders, which static markup never produces.
 *
 * Regression: the dialog's reset effect depended on `setCredential`, the
 * whole `useMutation` result, which TanStack Query returns as a new object on
 * every render. That reran the effect after every render while the dialog was
 * open, clearing the typed password and the mutation state each time, an
 * infinite render loop in the real app (React throws "Maximum update depth
 * exceeded"). The fix depends only on `reset`, the observer's stable function.
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});

const setObjectCredential = vi.fn();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, setObjectCredential: (...args: unknown[]) => setObjectCredential(...args) };
});

// See tenant-wizard.test.tsx: React only flushes effects synchronously inside
// `act` when it knows it is running under a test renderer, and nothing else
// sets this flag in this workspace.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const imapObject: ProtectedObject = {
  id: "o-imap-1",
  sourceId: "s-imap-1",
  sourceName: "Hoster",
  sourceKind: "imap",
  kind: "imap",
  origin: "manual",
  status: "active",
  externalId: "alice@hoster.example",
  displayName: "Alice",
  userId: null,
  email: "alice@hoster.example",
  upn: null,
  sharedOrBlocked: false,
  override: null,
  notSelected: false,
  lastBackupAt: null,
  snapshotCount: 0,
  legalHold: false,
  latestBackupJob: null,
  readiness: null,
  credential: {
    authMode: "per_mailbox",
    hasPassword: false,
    status: null,
    checkedAt: null,
    error: null,
    errorReason: null,
    failure: null,
  },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    setInputValue(input, value);
    await flush();
  });
}

async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
    await flush();
  });
}

describe("SetCredentialDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: MockInstance<typeof console.error>;

  let queryClient: QueryClient;

  function mount(onOpenChange: (open: boolean) => void = () => undefined) {
    queryClient = new QueryClient();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <SetCredentialDialog object={imapObject} open onOpenChange={onOpenChange} />
          </I18nextProvider>
        </QueryClientProvider>,
      );
    });
  }

  /** Re-renders the same mounted instance with a different `open`, the way the real dropdown/dialog does it (no remount). */
  function setOpen(open: boolean, onOpenChange: (open: boolean) => void = () => undefined) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <SetCredentialDialog object={imapObject} open={open} onOpenChange={onOpenChange} />
          </I18nextProvider>
        </QueryClientProvider>,
      );
    });
  }

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    setObjectCredential.mockReset();
    consoleError?.mockRestore();
  });

  it("keeps a typed password instead of clearing it on every render, and never hits React's update-depth limit", async () => {
    // A spy, not a hard failure inside the app: the buggy effect throws
    // "Maximum update depth exceeded" from inside React internals, which
    // would otherwise surface as an unhandled rejection rather than a clean
    // assertion failure.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mount();

    const input = document.body.querySelector<HTMLInputElement>("#credential-password");
    expect(input).not.toBeNull();
    await type(input as HTMLInputElement, "s3cret-mailbox-password");

    // The regression: a reset effect keyed on the whole mutation result
    // reran after this render too, calling setPassword("") right back.
    expect((input as HTMLInputElement).value).toBe("s3cret-mailbox-password");
    const loopErrors = consoleError.mock.calls.filter((call) =>
      String(call[0]).includes("Maximum update depth exceeded"),
    );
    expect(loopErrors).toHaveLength(0);
  });

  it("submits the typed password and closes the dialog once saved", async () => {
    setObjectCredential.mockResolvedValue({
      ...imapObject,
      credential: {
        authMode: "per_mailbox",
        hasPassword: true,
        status: "untested",
        checkedAt: null,
        error: null,
      },
    });
    const onOpenChange = vi.fn();
    mount(onOpenChange);

    const input = document.body.querySelector<HTMLInputElement>("#credential-password");
    await type(input as HTMLInputElement, "s3cret-mailbox-password");
    const submit = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save password",
    );
    expect(submit).toBeDefined();
    await click(submit as HTMLButtonElement);

    expect(setObjectCredential).toHaveBeenCalledWith("o-imap-1", "s3cret-mailbox-password");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("resets the password field and any previous error the next time the dialog reopens, without remounting", async () => {
    // Exercises the effect's actual trigger in the real app: the dropdown
    // keeps one dialog instance and flips `open`, it never remounts the
    // component - so this must go through the same root, not a fresh mount.
    const GENERIC_ERROR = "The action could not be completed. Please try again.";
    setObjectCredential.mockRejectedValue(new Error("boom"));
    mount();
    const input = document.body.querySelector<HTMLInputElement>(
      "#credential-password",
    ) as HTMLInputElement;
    await type(input, "first-try");
    const submit = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save password",
    ) as HTMLButtonElement;
    await click(submit);
    // The error alert is on screen (the mutation is in its error state).
    expect(document.body.textContent).toContain(GENERIC_ERROR);

    setOpen(false);
    setOpen(true);

    const reopened = document.body.querySelector<HTMLInputElement>("#credential-password");
    expect(reopened?.value).toBe("");
    expect(document.body.textContent).not.toContain(GENERIC_ERROR);
  });
});

describe("RemoveBlockedDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  function mount(
    block: "legal_hold" | "has_backups",
    props: { canExclude?: boolean; onExclude?: () => void } = {},
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <RemoveBlockedDialog
            object={{ ...imapObject, snapshotCount: 3, legalHold: block === "legal_hold" }}
            block={block}
            canExclude={props.canExclude ?? true}
            pending={false}
            open
            onOpenChange={() => undefined}
            onExclude={props.onExclude ?? (() => undefined)}
          />
        </I18nextProvider>,
      );
    });
  }

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const buttonLabels = () =>
    [...document.body.querySelectorAll("button")].map((button) => button.textContent?.trim());

  it("explains that backups stay and offers to exclude the account", async () => {
    const onExclude = vi.fn();
    mount("has_backups", { onExclude });
    expect(document.body.textContent).toContain("never deletes backups");
    expect(buttonLabels()).not.toContain("Remove");
    const exclude = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Exclude from protection",
    );
    expect(exclude).toBeDefined();
    await click(exclude as HTMLButtonElement);
    expect(onExclude).toHaveBeenCalledTimes(1);
  });

  it("says so instead of offering the button when the account is already excluded", () => {
    mount("has_backups", { canExclude: false });
    expect(buttonLabels()).not.toContain("Exclude from protection");
    expect(document.body.textContent).toContain("already excluded");
  });

  it("shows only a note for a legal hold", () => {
    mount("legal_hold");
    expect(document.body.textContent).toContain("legal hold");
    expect(buttonLabels()).not.toContain("Exclude from protection");
  });
});
