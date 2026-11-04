// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveGuestDetail, PveRestorePoint } from "./api";
import { PveGuestPage } from "./guest-page";

/**
 * The guest's page charts what each of its newest 30 backups added (#58), with a text
 * alternative and a table, from the restore points it loads anyway.
 */

vi.mock("@/features/endpoints/hooks", () => ({
  useTenantScope: () => ({ tenantId: "t-1", enabled: true }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to: _to,
    search: _search,
    params: _params,
    ...props
  }: Record<string, unknown>) => <a {...(props as object)}>{children as React.ReactNode}</a>,
  useNavigate: () => () => undefined,
}));
vi.mock("@/features/storage", () => ({
  BackupDestinationNote: () => null,
  ServerDiskWarning: () => null,
  useStorageScope: () => ({ canManage: false }),
}));
vi.mock("@/features/suspicion", () => ({
  judgementsById: () => new Map(),
  LastCleanHint: () => null,
  ObjectSuspicionBadge: () => null,
  RetentionHoldNotice: () => null,
  SuspicionBadge: () => null,
  useObjectSuspicions: () => ({ data: undefined }),
}));
const fetchGuest = vi.fn();
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchGuest: (...args: unknown[]) => fetchGuest(...args) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

function point(sequence: number, added: number | null): PveRestorePoint {
  return {
    id: `p-${sequence}`,
    sequence,
    kind: "ct",
    archiveName: `ct/117/${sequence}`,
    origin: "restow",
    backupAt: new Date(Date.UTC(2026, 9, sequence, 22)).toISOString(),
    byteSize: 9 * GiB,
    added,
    backupType: sequence === 1 ? "first" : "incremental",
    unreadable: 0,
    disks: [],
    verify: null,
    available: true,
  } as unknown as PveRestorePoint;
}

function detail(snapshots: PveRestorePoint[]): PveGuestDetail {
  return {
    guest: {
      id: "g-1",
      clusterId: "c-1",
      vmid: 117,
      kind: "ct",
      name: "paperless",
      node: "pmx01",
      status: "running",
      template: false,
      privileged: false,
      present: true,
      diskBytes: 0,
      jobId: null,
      jobName: null,
      attention: [],
    },
    cluster: null,
    followUp: null,
    bootTest: null,
    repository: null,
    snapshots,
    runs: [],
    tasks: [],
  } as unknown as PveGuestDetail;
}

describe("the guest page's new data per backup", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <PveGuestPage guestId="g-1" />
          </I18nextProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("charts the newest 30 points that recorded it, with a table of every bar", async () => {
    // Newest first, as the server lists them; point 39 recorded nothing.
    const points = Array.from({ length: 40 }, (_, index) =>
      point(40 - index, index === 1 ? null : index === 39 ? 32 * GiB : (index + 1) * MiB),
    );
    fetchGuest.mockResolvedValueOnce(detail(points));
    await mount();
    const chart = document.body.querySelector('[data-slot="pve-new-data"]');
    expect(chart?.textContent).toContain("New data per backup");
    expect(chart?.textContent).toContain("New data of the last 30 backups");
    const rows = [...(chart?.querySelectorAll('[data-slot="new-data-table"] tbody tr') ?? [])];
    expect(rows).toHaveLength(30);
    // Oldest first, the newest last.
    expect(rows.at(-1)?.lastElementChild?.textContent).toBe("1 MB");
    expect(rows.at(-1)?.textContent).toContain("Follow-up backup");
    // The chart sits with the restore points, above their table.
    expect(chart?.closest('section[aria-labelledby="pve-points"]')).not.toBeNull();
  });

  it("draws no chart while only one point recorded what it added", async () => {
    fetchGuest.mockResolvedValueOnce(detail([point(2, null), point(1, 9 * GiB)]));
    await mount();
    expect(document.body.querySelector('[data-slot="pve-restore-point"]')).not.toBeNull();
    expect(document.body.querySelector('[data-slot="pve-new-data"]')).toBeNull();
  });
});
