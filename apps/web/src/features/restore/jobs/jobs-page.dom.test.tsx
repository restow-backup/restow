// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RestoreJob } from "@/features/restore/api";
import { i18n } from "@/i18n";

import { RestoreJobsPage } from "./jobs-page";

/**
 * "Recent restores" (I-6, K-9): it says what it lists (mailboxes, OneDrive,
 * IMAP; restores onto machines live elsewhere, with a link there) and how
 * many it shows, and loads older restores instead of dropping them.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({ to, children, ...props }: { to: string; children?: React.ReactNode }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});
vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", role: "tenant_admin" },
    isProviderAdmin: false,
  }),
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

function job(index: number): RestoreJob {
  return {
    id: `r${index}`,
    jobId: `j${index}`,
    snapshotId: "s1",
    snapshotSequence: 1,
    snapshotAt: "2026-10-01T10:00:00.000Z",
    object: { id: "o1", kind: "mailbox", externalId: "x", displayName: "Anna" },
    target: { type: "original", ref: null },
    mode: "rename",
    selection: { items: 1, folders: 0 } as RestoreJob["selection"],
    reason: null,
    impersonated: false,
    actor: { userId: "u1", name: "Lena", email: "lena@example.test" },
    status: "completed",
    createdAt: "2026-10-01T10:00:00.000Z",
    startedAt: null,
    completedAt: "2026-10-01T10:05:00.000Z",
    errorMessage: null,
    progress: null,
    throttle: null,
    result: null,
    download: { available: false, expiresAt: null },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RestoreJobsPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function settle() {
    for (let attempt = 0; attempt < 10; attempt++) {
      await act(async () => {
        await flush();
      });
    }
  }

  beforeEach(() => {
    apiFetch.mockImplementation((path: string) => {
      const offset = Number(new URLSearchParams(path.split("?")[1] ?? "").get("offset") ?? "0");
      return Promise.resolve({
        items: Array.from({ length: offset === 0 ? 100 : 3 }, (_, index) => job(offset + index)),
      });
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nextProvider i18n={i18n}>
            <RestoreJobsPage />
          </I18nextProvider>
        </QueryClientProvider>,
      );
      await flush();
    });
    await settle();
  }

  const text = () => container.textContent ?? "";

  it("says what it lists and where restores onto machines are", async () => {
    await mount();
    expect(text()).toContain("Restores and downloads of mailboxes, OneDrive and IMAP accounts");
    const machines = [...container.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("Restores onto machines"),
    );
    expect(machines?.getAttribute("href")).toBe("/file-restore");
  });

  it("names how many restores are shown and loads older ones", async () => {
    await mount();
    expect(text()).toContain("The newest 100 requests are shown.");
    const more = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Show older"),
    );
    await act(async () => {
      more?.click();
      await flush();
    });
    await settle();
    expect(apiFetch.mock.calls.some(([path]) => String(path).includes("offset=100"))).toBe(true);
    expect(text()).toContain("The newest 103 requests are shown.");
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Show older")),
    ).toBe(false);
  });
});
