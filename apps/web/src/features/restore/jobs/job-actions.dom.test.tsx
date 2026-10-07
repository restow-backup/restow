// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { CancelRestoreButton, RequestAgainLink } from "./job-actions";

/**
 * Restore job actions: cancelling a download says that no file will be made
 * (a ZIP only exists once the run is complete), and an expired or cancelled
 * download leads back to the explorer at the same account and restore point.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      children,
      ...props
    }: { to: string; search?: Record<string, string>; children?: React.ReactNode }) => (
      <a href={`${String(to)}?${new URLSearchParams(search ?? {}).toString()}`} {...props}>
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
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("restore job actions", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(node: React.ReactNode) {
    const client = new QueryClient();
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
        </QueryClientProvider>,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  async function openCancel() {
    await act(async () => {
      container.querySelector("button")?.click();
    });
    return document.body.textContent ?? "";
  }

  it("says that cancelling a download leaves no file", async () => {
    render(
      <CancelRestoreButton job={{ id: "r1", status: "active", target: { type: "download" } }} />,
    );
    const text = await openCancel();
    expect(text).toContain("No file is created");
    expect(text).not.toContain("What has already been restored stays in place.");
  });

  it("says that a restore into an account keeps what it already wrote", async () => {
    render(
      <CancelRestoreButton job={{ id: "r1", status: "active", target: { type: "original" } }} />,
    );
    const text = await openCancel();
    expect(text).toContain("What has already been restored stays in place.");
  });

  it("leads back to the explorer at the same account and restore point", () => {
    render(
      <RequestAgainLink
        job={{
          object: { id: "o-1", kind: "mailbox", externalId: "x", displayName: "Anna" },
          snapshotId: "s-9",
          snapshotSequence: 9,
        }}
      />,
    );
    const link = container.querySelector<HTMLAnchorElement>("[data-slot=request-again]");
    expect(link?.textContent).toContain("Request again in the explorer");
    expect(link?.getAttribute("href")).toContain("object=o-1");
    expect(link?.getAttribute("href")).toContain("snapshot=s-9");
  });

  it("offers nothing when the restore point is gone", () => {
    render(
      <RequestAgainLink
        job={{
          object: { id: "o-1", kind: "mailbox", externalId: "x", displayName: "Anna" },
          snapshotId: "s-9",
          snapshotSequence: null,
        }}
      />,
    );
    expect(container.querySelector("[data-slot=request-again]")).toBeNull();
  });
});
