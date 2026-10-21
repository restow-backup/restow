// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveNode } from "./api";
import {
  CancelBackupButton,
  CancelQueuedButton,
  NodeQueueButton,
  NodeUpdateButton,
  QueuePausedBadge,
} from "./cancel-controls";

/**
 * Stopping backups of VMs and containers (0.4.2): every stop asks first and then calls the
 * server; a stop already asked for shows "Cancelling…" instead of the button; a node's queue
 * can be paused and resumed, and its queued backups withdrawn; a node behind the release gets
 * "Update to …".
 */

vi.mock("@/features/endpoints/hooks", () => ({
  useTenantScope: () => ({ tenantId: "t-1", enabled: true }),
}));
const cancelGuestBackup = vi.fn(async () => ({ withdrawn: 0, stopping: 1 }));
const cancelQueuedBackups = vi.fn(async () => ({ withdrawn: 3, stopping: 0 }));
const setNodeQueuePaused = vi.fn(async () => ({ queuePausedAt: null, queuePausedBy: null }));
const requestNodeUpdate = vi.fn(async () => ({ updateRequestedAt: "2026-10-21T10:00:00.000Z" }));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    cancelGuestBackup: (...args: unknown[]) => cancelGuestBackup(...(args as [])),
    cancelQueuedBackups: (...args: unknown[]) => cancelQueuedBackups(...(args as [])),
    setNodeQueuePaused: (...args: unknown[]) => setNodeQueuePaused(...(args as [])),
    requestNodeUpdate: (...args: unknown[]) => requestNodeUpdate(...(args as [])),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function node(over: Partial<PveNode> = {}): PveNode {
  return {
    id: "n-1",
    name: "pmx02",
    helperVersion: "0.4.1",
    pveVersion: "9.2",
    fleecingStorage: "local-lvm",
    lastSeenAt: "2026-10-21T10:00:00.000Z",
    online: true,
    problems: [],
    pluginLoaded: true,
    restoresAllowed: true,
    queuePausedAt: null,
    queuePausedBy: null,
    queuedBackups: 0,
    updateVersion: null,
    updateRequestedAt: null,
    ...over,
  };
}

describe("cancel controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(element: React.ReactElement) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>{element}</I18nextProvider>
        </QueryClientProvider>,
      );
    });
  }

  const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  const text = () => document.body.textContent ?? "";
  /** A button of the open question (the dialog), by its text. */
  const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
      (b) => b.textContent?.trim() === label,
    );
  async function click(element: HTMLElement | null | undefined) {
    expect(element).toBeTruthy();
    await act(async () => {
      element?.click();
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("asks before it stops a running backup, then asks the server", async () => {
    await mount(<CancelBackupButton guestId="g-1" name="web" activity="running" />);
    const stop = slot("pve-cancel-backup");
    expect(stop?.getAttribute("aria-label")).toBe("Stop the backup of web");
    await click(stop);
    expect(text()).toContain("Stop the backup of web?");
    expect(text()).toContain("cancelled, not as failed");
    expect(cancelGuestBackup).not.toHaveBeenCalled();
    await click(button("Stop backup") ?? null);
    expect(cancelGuestBackup).toHaveBeenCalledWith("g-1");
  });

  it("withdraws a queued backup after the question, and keeps it on 'Keep it'", async () => {
    await mount(<CancelBackupButton guestId="g-2" name="db" activity="queued" />);
    await click(slot("pve-cancel-backup"));
    expect(text()).toContain("Withdraw the queued backup of db?");
    await click(button("Keep it") ?? null);
    expect(cancelGuestBackup).not.toHaveBeenCalled();
  });

  it("shows 'Cancelling…' instead of the button once a stop was asked for", async () => {
    await mount(
      <CancelBackupButton
        guestId="g-3"
        name="mail"
        activity="running"
        cancelling
        cancelledBy="admin@contoso.example"
      />,
    );
    expect(slot("pve-cancel-backup")).toBeNull();
    expect(slot("pve-cancelling")?.textContent).toBe("Cancelling…");
    expect(slot("pve-cancelling")?.getAttribute("title")).toBe(
      "Stop requested by admin@contoso.example",
    );
  });

  it("withdraws every queued backup of a node after the question", async () => {
    await mount(<CancelQueuedButton node={{ id: "n-1", name: "pmx02" }} count={3} />);
    expect(slot("pve-cancel-queued")?.textContent).toContain("Cancel all 3 queued");
    await click(slot("pve-cancel-queued"));
    expect(text()).toContain("Withdraw all 3 backups queued on pmx02?");
    await click(button("Withdraw") ?? null);
    expect(cancelQueuedBackups).toHaveBeenCalledWith("n-1");
  });

  it("renders nothing to withdraw when nothing waits", async () => {
    await mount(<CancelQueuedButton node={null} count={0} />);
    expect(slot("pve-cancel-queued")).toBeNull();
  });

  it("pauses a node's queue after the question and resumes it at once", async () => {
    await mount(<NodeQueueButton node={node()} />);
    await click(slot("pve-queue-pause"));
    expect(text()).toContain("Pause the queue of pmx02?");
    await click(button("Pause queue") ?? null);
    expect(setNodeQueuePaused).toHaveBeenCalledWith("n-1", true);
    act(() => root.unmount());
    await mount(
      <>
        <QueuePausedBadge
          node={node({ queuePausedAt: "2026-10-21T09:00:00.000Z", queuePausedBy: "ops@x.example" })}
        />
        <NodeQueueButton
          node={node({ queuePausedAt: "2026-10-21T09:00:00.000Z", queuePausedBy: "ops@x.example" })}
        />
      </>,
    );
    expect(slot("pve-queue-paused")?.textContent).toBe("Paused by ops@x.example");
    await click(slot("pve-queue-resume"));
    expect(setNodeQueuePaused).toHaveBeenLastCalledWith("n-1", false);
  });

  it("offers 'Update to …' for a node behind the release, and says when it was asked", async () => {
    await mount(<NodeUpdateButton node={node()} />);
    expect(slot("pve-node-update")).toBeNull();
    act(() => root.unmount());
    await mount(<NodeUpdateButton node={node({ updateVersion: "0.4.2" })} />);
    expect(slot("pve-node-update")?.textContent).toContain("Update to 0.4.2");
    await click(slot("pve-node-update"));
    expect(requestNodeUpdate).toHaveBeenCalledWith("n-1");
    act(() => root.unmount());
    await mount(
      <NodeUpdateButton
        node={node({ updateVersion: "0.4.2", updateRequestedAt: "2026-10-21T10:00:00.000Z" })}
      />,
    );
    expect(slot("pve-node-updating")?.textContent).toBe("Updating to 0.4.2…");
  });
});
