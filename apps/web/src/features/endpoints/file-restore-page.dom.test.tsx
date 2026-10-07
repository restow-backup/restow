// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { EndpointSummary } from "./api.js";
import { type Mounted, mount } from "./dom-harness.js";
import { FileRestorePage } from "./file-restore-page.js";
import "./i18n.js";

/**
 * File restore lists the machines (servers and clients) only. Mailboxes,
 * OneDrives and IMAP accounts never appear here: they are restored in the
 * restore explorer, and the page does not even ask for them.
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", name: "Contoso" },
    user: { id: "u-1" },
  }),
}));
const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({
      to,
      search,
      children,
      ...props
    }: {
      to: string;
      search?: unknown;
      children: React.ReactNode;
    }) => (
      <a href={String(to)} data-search={JSON.stringify(search ?? {})} {...props}>
        {children}
      </a>
    ),
  };
});

const fetchEndpoints = vi.fn();
vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return { ...actual, fetchEndpoints: (...args: unknown[]) => fetchEndpoints(...args) };
});
const fetchSnapshotObjects = vi.fn();
vi.mock("@/features/restore/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/restore/api")>();
  return {
    ...actual,
    fetchSnapshotObjects: (...args: unknown[]) => fetchSnapshotObjects(...args),
  };
});

function machine(over: Partial<EndpointSummary> = {}): EndpointSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    hostname: "web-01",
    displayName: null,
    lastBackupAt: null,
    ...over,
  } as EndpointSummary;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("FileRestorePage", () => {
  let page: Mounted;

  beforeEach(() => {
    navigate.mockReset();
    fetchSnapshotObjects.mockReset().mockResolvedValue([]);
    fetchEndpoints
      .mockReset()
      .mockResolvedValue([machine(), machine({ id: "m-2", hostname: "db-01" })]);
  });
  afterEach(() => page?.unmount());

  async function open(machineId: string | null = null) {
    page = mount();
    await page.render(<FileRestorePage machineId={machineId} />);
    await page.settle();
  }

  it("lists the machines only and never asks for mailboxes", async () => {
    await open();
    expect(page.byText("[data-slot='machine-list'] button", "web-01")).toBeTruthy();
    expect(page.byText("[data-slot='machine-list'] button", "db-01")).toBeTruthy();
    expect(document.querySelector("[data-slot='mailbox-list']")).toBeNull();
    expect(fetchSnapshotObjects).not.toHaveBeenCalled();
    expect(page.text()).toContain("Choose a machine");
  });

  it("searches the machines", async () => {
    await open();
    const search = page.container.querySelector<HTMLInputElement>("input[type='search']");
    if (!search) throw new Error("no search");
    await page.type(search, "db");
    expect(page.maybeByText("[data-slot='machine-list'] button", "web-01")).toBeNull();
    expect(page.byText("[data-slot='machine-list'] button", "db-01")).toBeTruthy();
    await page.type(search, "nothing like it");
    expect(page.text()).toContain("No machine matches the search.");
  });

  it("puts the chosen machine in the URL", async () => {
    await open();
    await page.click(page.byText("[data-slot='machine-list'] button", "db-01"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/file-restore",
      search: { machine: "m-2" },
      replace: true,
    });
  });

  it("points to the inventory when the tenant has no machine", async () => {
    fetchEndpoints.mockResolvedValue([]);
    await open();
    expect(page.text()).toContain("Nothing backed up yet");
    expect(document.querySelector("[data-slot='machine-picker']")).toBeNull();
  });
});
