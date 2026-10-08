// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { LegalHold } from "./api";
import { LegalHoldsSection } from "./legal-holds-section";

/**
 * Legal holds in a real DOM: each hold with its scope and dates, a release
 * that asks first and only goes ahead with a reason (sent to the API for the
 * audit log), and a failed release that keeps the dialog open with the cause.
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", role: "tenant_admin" },
    isProviderAdmin: false,
    extensions: { edition: "business" },
  }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: (path: string, init?: unknown) => apiFetch(path, init) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const MAILBOX = "11111111-1111-4111-8111-111111111111";

const holds: LegalHold[] = [
  {
    id: "h-1",
    reason: "Tax audit 2026",
    protectedObjectId: null,
    active: true,
    createdAt: "2026-09-01T08:00:00.000Z",
    releasedAt: null,
  },
  {
    id: "h-2",
    reason: "Dispute with supplier",
    protectedObjectId: MAILBOX,
    active: false,
    createdAt: "2026-05-01T08:00:00.000Z",
    releasedAt: "2026-06-01T08:00:00.000Z",
  },
];

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setValue(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("LegalHoldsSection release", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function settle() {
    for (let attempt = 0; attempt < 10; attempt++) {
      await act(async () => {
        await flush();
      });
    }
  }

  async function mount() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <LegalHoldsSection />
          </I18nextProvider>
        </QueryClientProvider>,
      );
      await flush();
    });
    await settle();
  }

  const dialog = () => document.body.querySelector('[role="alertdialog"]');
  const confirm = () => dialog()?.querySelector<HTMLButtonElement>('button[type="submit"]');
  const deletes = () =>
    apiFetch.mock.calls.filter(([, init]) => (init as { method?: string })?.method === "DELETE");

  async function click(element: Element | null | undefined) {
    await act(async () => {
      (element as HTMLElement).click();
      await flush();
    });
    await settle();
  }

  beforeEach(() => {
    apiFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === "/archive/legal-holds" && !init?.method) {
        return Promise.resolve({ items: holds });
      }
      if (path === "/archive/legal-holds/h-1" && init?.method === "DELETE") {
        return Promise.resolve({
          ...holds[0],
          active: false,
          releasedAt: new Date().toISOString(),
        });
      }
      if (path.startsWith("/snapshots/objects")) {
        return Promise.resolve({
          items: [
            {
              id: MAILBOX,
              kind: "mailbox",
              externalId: "x",
              displayName: "Anna Berg",
              ownerEmail: "anna@contoso.test",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("lists every hold with its scope, status and dates", async () => {
    await mount();
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Tax audit 2026");
    expect(rows[0]?.textContent).toContain("Whole tenant");
    expect(rows[0]?.textContent).toContain("Active");
    expect(rows[1]?.textContent).toContain("Released");
    // A hold on one mailbox names it, with its address.
    expect(rows[1]?.textContent).toContain("Anna Berg (anna@contoso.test)");
    // Placed and released dates are both shown.
    expect(rows[1]?.querySelectorAll("td")[3]?.textContent).not.toBe("—");
    expect(rows[1]?.querySelectorAll("td")[4]?.textContent).not.toBe("—");
    // Only an active hold can be released.
    expect(rows[1]?.querySelector("button")).toBeNull();
  });

  it("asks before releasing and requires a reason, which goes to the API", async () => {
    await mount();
    await click(container.querySelector("tbody tr button"));
    expect(dialog()?.textContent).toContain("Release legal hold?");
    expect(dialog()?.textContent).toContain("cannot be undone");
    expect(dialog()?.textContent).toContain("Tax audit 2026");
    expect(confirm()?.disabled).toBe(true);

    await act(async () => {
      setValue(
        dialog()?.querySelector("#legal-hold-release-reason") as HTMLTextAreaElement,
        "Audit closed",
      );
      await flush();
    });
    expect(confirm()?.disabled).toBe(false);
    await click(confirm());

    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]).toEqual([
      "/archive/legal-holds/h-1",
      { method: "DELETE", body: { reason: "Audit closed" } },
    ]);
    expect(toastSuccess).toHaveBeenCalledWith("Legal hold released");
    expect(dialog()).toBeNull();
  });

  it("keeps the dialog open with the cause when the release fails", async () => {
    await mount();
    apiFetch.mockImplementation((path: string, init?: { method?: string }) =>
      init?.method === "DELETE"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(path === "/archive/legal-holds" ? { items: holds } : {}),
    );
    await click(container.querySelector("tbody tr button"));
    await act(async () => {
      setValue(
        dialog()?.querySelector("#legal-hold-release-reason") as HTMLTextAreaElement,
        "Audit closed",
      );
      await flush();
    });
    await click(confirm());
    expect(dialog()?.textContent).toContain("The action could not be completed");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("reports a hold that could not be placed", async () => {
    await mount();
    apiFetch.mockImplementation((path: string, init?: { method?: string }) =>
      init?.method === "POST"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(path === "/archive/legal-holds" ? { items: holds } : {}),
    );
    await act(async () => {
      setValue(container.querySelector("#legal-hold-reason") as HTMLTextAreaElement, "New case");
      await flush();
    });
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    });
    await settle();
    expect(toastError).toHaveBeenCalledWith(
      "The legal hold could not be placed",
      expect.anything(),
    );
  });
});
