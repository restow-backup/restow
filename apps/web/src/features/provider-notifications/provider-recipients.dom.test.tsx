// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  type Mounted,
  mount,
  routedFetch,
  SESSION,
  sessionAs,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import type { SessionContextValue } from "@/lib/session";

import type { ProviderRecipient, ProviderRecipientsView, SummaryReportsView } from "./api";
import { ProviderNotificationsSection } from "./provider-notifications-section";

/**
 * Installation › Notifications: the owners of the provider team cannot be removed and keep the
 * critical events locked on; only an owner sees the Mandatory switch; every recipient picks at
 * once or a digest per severity; the summary report rows stay closed without timed reports.
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

const IMMEDIATE = { error: "immediate", warning: "immediate", info: "immediate" } as const;
const FLOOR = ["backup.suspicious", "verify.red", "notification.delivery_failed"] as const;

const OWNER: ProviderRecipient = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "owner@provider.example",
  name: "Olga Owner",
  kind: "owner",
  mandatory: false,
  userId: "u1",
  events: ["backup.failed"],
  delivery: IMMEDIATE,
  language: null,
  lockedEvents: [...FLOOR],
  failure: null,
};

const MEMBER: ProviderRecipient = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "ops@provider.example",
  name: "Ops",
  kind: "member",
  mandatory: false,
  userId: null,
  events: [],
  delivery: IMMEDIATE,
  language: "de",
  lockedEvents: [],
  failure: { since: "2026-11-05T08:00:00.000Z", reason: "recipient_rejected", detail: "550" },
};

function view(over: Partial<ProviderRecipientsView> = {}): ProviderRecipientsView {
  return {
    events: [
      {
        name: "backup.failed",
        group: "jobs",
        level: "error",
        critical: false,
        installation: false,
      },
      {
        name: "backup.suspicious",
        group: "jobs",
        level: "error",
        critical: true,
        installation: false,
      },
      {
        name: "verify.red",
        group: "recoverability",
        level: "error",
        critical: true,
        installation: false,
      },
      {
        name: "update.available",
        group: "system",
        level: "info",
        critical: false,
        installation: true,
      },
      {
        name: "notification.delivery_failed",
        group: "system",
        level: "error",
        critical: false,
        installation: false,
      },
    ],
    summaryAvailable: true,
    floorEvents: [...FLOOR],
    canEditMandatory: true,
    recipients: [OWNER, MEMBER],
    ...over,
  };
}

const SUMMARIES: SummaryReportsView = {
  available: true,
  reports: (["daily", "weekly", "monthly"] as const).map((cadence) => ({
    cadence,
    enabled: cadence === "weekly",
    attachPdf: true,
    sendHour: 7,
    recipients: cadence === "weekly" ? ["owner@provider.example"] : [],
    nextRunAt: null,
    lastRunAt: null,
    lastDelivery: null,
  })),
};

async function open(
  recipients: ProviderRecipientsView = view(),
  options: {
    session?: SessionContextValue;
    summaries?: SummaryReportsView;
    routes?: Parameters<typeof routedFetch>[0];
  } = {},
) {
  const { mock, requests } = routedFetch({
    "GET /settings/notification-recipients": () => json(recipients),
    "GET /settings/summary-reports": () => json(options.summaries ?? SUMMARIES),
    "GET /setup/state": () => json({ demo: { enabled: false } }),
    ...options.routes,
  });
  vi.stubGlobal("fetch", mock);
  mounted = mount(<ProviderNotificationsSection />, { session: options.session ?? SESSION });
  await flush(8);
  return { requests };
}

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-slot=provider-recipient]")];
const matrix = () => document.querySelector<HTMLElement>("[data-slot=provider-matrix]");
const cell = (label: string) =>
  matrix()?.querySelector<HTMLButtonElement>(`[role=checkbox][aria-label="${label}"]`) ?? null;

async function select(element: HTMLSelectElement | null | undefined, value: string) {
  if (!element) throw new Error("no select");
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("ProviderNotificationsSection", () => {
  it("lists the owner without a remove action and with the owner badge", async () => {
    await open();
    const [owner, member] = rows();
    expect(owner?.getAttribute("data-kind")).toBe("owner");
    expect(owner?.querySelector("[data-slot=badge-owner]")?.textContent).toBe("Owner");
    expect(owner?.querySelector("[data-slot=recipient-remove]")).toBeNull();
    expect(owner?.querySelector<HTMLInputElement>("input[type=email]")?.disabled).toBe(true);
    expect(member?.querySelector("[data-slot=recipient-remove]")).not.toBeNull();
    expect(member?.querySelector("[data-slot=recipient-failure]")?.textContent).toContain(
      "Mail fails since",
    );
  });

  it("shows the Mandatory switch to owners only, and only for members", async () => {
    await open();
    const [owner, member] = rows();
    expect(owner?.querySelector("[data-slot=mandatory-toggle]")).toBeNull();
    expect(member?.querySelector("[data-slot=mandatory-toggle]")).not.toBeNull();
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";

    await open(view({ canEditMandatory: false }), {
      session: sessionAs({ providerRole: "administrator" }),
    });
    expect(document.querySelector("[data-slot=mandatory-toggle]")).toBeNull();
  });

  it("keeps an administrator from removing a mandatory recipient or changing its address", async () => {
    const mandatory = { ...MEMBER, mandatory: true, failure: null };
    await open(view({ canEditMandatory: false, recipients: [OWNER, mandatory] }), {
      session: sessionAs({ providerRole: "administrator" }),
    });
    const [, member] = rows();
    expect(member?.querySelector("[data-slot=recipient-remove]")).toBeNull();
    expect(member?.querySelector<HTMLInputElement>("input[type=email]")?.disabled).toBe(true);
    expect(member?.querySelector("[data-slot=mandatory-locked-hint]")?.textContent).toContain(
      "only an owner",
    );
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
    // An owner may.
    await open(view({ recipients: [OWNER, mandatory] }));
    const [, editable] = rows();
    expect(editable?.querySelector("[data-slot=recipient-remove]")).not.toBeNull();
    expect(editable?.querySelector<HTMLInputElement>("input[type=email]")?.disabled).toBe(false);
  });

  it("locks the critical cells of the floor and leaves the member's open", async () => {
    await open();
    const locked = [...(matrix()?.querySelectorAll("[data-slot=locked-cell]") ?? [])];
    // The owner's three floor events (two critical, the failed delivery); none of the member's.
    expect(locked).toHaveLength(3);
    expect(
      cell("Suspicious backup (signs of ransomware) for Olga Owner")?.hasAttribute("disabled"),
    ).toBe(true);
    expect(
      cell("Suspicious backup (signs of ransomware) for Olga Owner")?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(cell("Suspicious backup (signs of ransomware) for Ops")?.hasAttribute("disabled")).toBe(
      false,
    );
    expect(
      cell("Suspicious backup (signs of ransomware) for Ops")?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(document.querySelector("[data-slot=critical-note]")?.textContent).toContain(
      "Critical events always come at once",
    );
  });

  it("locks the floor's cells of a member once it is made mandatory", async () => {
    await open();
    const [, member] = rows();
    await click(member?.querySelector("[data-slot=mandatory-toggle]"));
    await flush(2);
    expect(matrix()?.querySelectorAll("[data-slot=locked-cell]")).toHaveLength(6);
  });

  it("saves the delivery modes, the events and mandatory in one request", async () => {
    const { requests } = await open(view(), {
      routes: { "PUT /settings/notification-recipients": () => json(view()) },
    });
    const selects = [
      ...(matrix()?.querySelectorAll<HTMLSelectElement>("[data-slot=delivery-select]") ?? []),
    ];
    // Two columns, three severities each.
    expect(selects).toHaveLength(6);
    expect(selects.map((element) => element.getAttribute("data-level"))).toEqual([
      "error",
      "warning",
      "info",
      "error",
      "warning",
      "info",
    ]);
    await select(selects[4], "daily");
    await click(cell("Backup failed for Ops"));
    await click(rows()[1]?.querySelector("[data-slot=mandatory-toggle]"));
    await flush(2);
    await click(document.querySelector("[data-slot=provider-recipients-save]"));
    await flush(6);
    const put = requests.find((request) => request.method === "PUT");
    expect(put?.body).toEqual({
      recipients: [
        {
          id: OWNER.id,
          email: "owner@provider.example",
          name: "Olga Owner",
          events: ["backup.failed"],
          delivery: IMMEDIATE,
          language: null,
        },
        {
          id: MEMBER.id,
          email: "ops@provider.example",
          name: "Ops",
          mandatory: true,
          events: ["backup.failed"],
          delivery: { error: "immediate", warning: "daily", info: "immediate" },
          language: "de",
        },
      ],
    });
  });

  it("closes the summary report rows without timed reports and shows the edition", async () => {
    await open(view({ summaryAvailable: false }), {
      summaries: { available: false, reports: [] },
    });
    const reports = document.querySelector("[data-slot=provider-matrix-reports]");
    const cells = [
      ...(reports?.querySelectorAll<HTMLButtonElement>("[data-slot=summary-cell]") ?? []),
    ];
    expect(cells).toHaveLength(6);
    expect(cells.every((element) => element.hasAttribute("disabled"))).toBe(true);
    expect(reports?.querySelector("[data-slot=feature-locked]")?.getAttribute("data-feature")).toBe(
      "reports.timed",
    );
    expect(
      document
        .querySelector("[data-slot=summary-reports] [data-slot=feature-locked]")
        ?.getAttribute("data-feature"),
    ).toBe("reports.timed");
  });

  it("switches the PDF of a summary report", async () => {
    const { requests } = await open(view(), {
      routes: {
        "PUT /settings/summary-reports/weekly": () =>
          json({ ...SUMMARIES.reports[1], attachPdf: false }),
      },
    });
    const weekly = document.querySelector("[data-slot=summary-report][data-cadence=weekly]");
    await click(weekly?.querySelector("#summary-weekly-pdf"));
    await flush(4);
    expect(requests.find((request) => request.method === "PUT")).toMatchObject({
      path: "/settings/summary-reports/weekly",
      body: { attachPdf: false },
    });
  });

  it("keeps a new row from saving until its address is valid", async () => {
    const { requests } = await open();
    await click(buttonByText(document.body, "Add recipient"));
    await flush(2);
    expect(rows()).toHaveLength(3);
    await click(document.querySelector("[data-slot=provider-recipients-save]"));
    await flush(2);
    expect(document.body.textContent).toContain("Enter an e-mail address.");
    expect(requests.some((request) => request.method === "PUT")).toBe(false);
  });
});
