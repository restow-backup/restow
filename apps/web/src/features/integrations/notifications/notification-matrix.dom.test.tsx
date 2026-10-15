// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { adminSession } from "@/features/backup-jobs/testing";
import type { NotificationMatrix } from "@/features/reports/api";
import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  type Mounted,
  mount,
  newQueryClient,
  routedFetch,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "../i18n.js";
import { NotificationMatrixPanel } from "./notification-matrix.js";

/**
 * The matrix shows every channel of the tenant as a column and every event as a row marked by
 * severity; unticking "Backup succeeded" for a Discord webhook and saving sends that column only;
 * a column's quick choice sets it at once; the arrow keys move between the cells; on a phone the
 * same cells are offered one channel at a time.
 */

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const MATRIX: NotificationMatrix = {
  events: [
    { name: "backup.failed", group: "jobs", level: "error" },
    { name: "backup.overdue", group: "jobs", level: "warning" },
    { name: "backup.succeeded", group: "jobs", level: "info" },
    { name: "verify.red", group: "recoverability", level: "error" },
  ],
  channels: [
    {
      kind: "bell",
      id: "bell",
      events: ["backup.failed", "backup.overdue", "verify.red"],
      custom: false,
    },
    {
      kind: "webhook",
      id: "11111111-1111-4111-8111-111111111111",
      name: "Ops channel",
      host: "discord.com",
      format: "discord",
      active: true,
      events: ["backup.failed", "backup.overdue", "backup.succeeded", "verify.red"],
    },
    {
      kind: "email",
      id: "22222222-2222-4222-8222-222222222222",
      email: "ops@contoso.example",
      name: null,
      events: ["backup.failed"],
      weeklyReport: true,
    },
  ],
};

async function open(routes: Parameters<typeof routedFetch>[0] = {}) {
  const { mock, requests } = routedFetch({
    "GET /reports/matrix": () => json(MATRIX),
    ...routes,
  });
  vi.stubGlobal("fetch", mock);
  mounted = mount(<NotificationMatrixPanel />, {
    session: adminSession(),
    queryClient: newQueryClient(),
  });
  await flush(6);
  return { requests };
}

function press(element: Element | null, arrow: string) {
  element?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: arrow }));
}

const grid = () => document.querySelector<HTMLElement>("[data-slot=matrix-grid]");
const cell = (label: string) =>
  grid()?.querySelector<HTMLButtonElement>(`[role=checkbox][aria-label="${label}"]`) ?? null;

describe("NotificationMatrixPanel", () => {
  it("shows the channels as columns and the events by group and severity", async () => {
    await open();
    const headers = [...(grid()?.querySelectorAll("[data-slot=matrix-channel]") ?? [])].map(
      (header) => header.textContent ?? "",
    );
    expect(headers[0]).toContain("Bell");
    expect(headers[1]).toContain("Ops channel");
    expect(headers[1]).toContain("Discord");
    expect(headers[2]).toContain("ops@contoso.example");
    expect(grid()?.textContent).toContain("Runs");
    expect(grid()?.textContent).toContain("Backup succeeded");
    expect(grid()?.textContent).toContain("Warning");
    expect(cell("Backup succeeded for Ops channel")?.getAttribute("aria-checked")).toBe("true");
    expect(cell("Backup succeeded for Bell")?.getAttribute("aria-checked")).toBe("false");
  });

  it("unticks Backup succeeded for the Discord webhook and saves that column only", async () => {
    const { requests } = await open({
      "PUT /reports/matrix": () =>
        json({
          ...MATRIX,
          channels: MATRIX.channels.map((channel) =>
            channel.kind === "webhook"
              ? { ...channel, events: ["backup.failed", "backup.overdue", "verify.red"] }
              : channel,
          ),
        }),
    });
    const save = buttonByText(document.body, "Save");
    expect(save?.disabled).toBe(true);
    await click(cell("Backup succeeded for Ops channel"));
    await flush(2);
    expect(document.body.textContent).toContain("1 channel changed, not saved yet.");
    await click(buttonByText(document.body, "Save"));
    await flush(6);
    const put = requests.find((request) => request.method === "PUT");
    expect(put?.body).toEqual({
      channels: [
        {
          kind: "webhook",
          id: "11111111-1111-4111-8111-111111111111",
          events: ["backup.failed", "backup.overdue", "verify.red"],
        },
      ],
    });
    expect(cell("Backup succeeded for Ops channel")?.getAttribute("aria-checked")).toBe("false");
  });

  it("moves between the cells with the arrow keys", async () => {
    await open();
    const first = cell("Backup failed for Bell");
    first?.focus();
    press(first, "ArrowRight");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Backup failed for Ops channel",
    );
    press(document.activeElement, "ArrowDown");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Backup overdue for Ops channel",
    );
  });

  it("offers one channel at a time on a phone, with the quick choices", async () => {
    await open();
    const phone = document.querySelector<HTMLElement>("[data-slot=matrix-phone]");
    expect(phone).not.toBeNull();
    // The bell is the first channel; its events are listed with checkboxes of their own.
    expect(phone?.querySelectorAll("[role=checkbox]")).toHaveLength(4);
    await click(buttonByText(phone as HTMLElement, "Errors only"));
    await flush(2);
    expect(document.body.textContent).toContain("1 channel changed, not saved yet.");
    expect(cell("Backup overdue for Bell")?.getAttribute("aria-checked")).toBe("false");
  });
});
