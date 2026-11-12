// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  json,
  type Mounted,
  mount,
  routedFetch,
  sessionAs,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import type { ReportRule } from "./api";
import { RuleFormDialog } from "./rule-form-dialog";

/**
 * The recipients of a rule that carries a category of the tenant's notification
 * recipients are those recipients: the field is read-only and says where to
 * change them. A rule made by hand keeps an editable field.
 */

enableActEnvironment();

const ACTIVE = {
  id: "t-1",
  name: "Contoso",
  slug: "contoso",
  kind: "customer" as const,
  customerNumber: null,
  role: "tenant_admin" as const,
  status: "active" as const,
};

function rule(over: Partial<ReportRule> = {}): ReportRule {
  return {
    id: "r-1",
    name: "Failed jobs",
    enabled: true,
    trigger: "event",
    events: ["backup.failed"],
    throttleMinutes: 60,
    intervalMinutes: null,
    cron: null,
    timezone: "UTC",
    nextRunAt: null,
    lastRunAt: null,
    periodDays: 7,
    sections: [],
    emailRecipients: ["ops@example.test"],
    recipientCategory: null,
    inApp: false,
    webhookId: null,
    language: null,
    locked: false,
    lastDelivery: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...over,
  };
}

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.stubGlobal("fetch", routedFetch({ "GET /webhooks": () => json([]) }).mock);
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function open(over: Partial<ReportRule>) {
  mounted = mount(
    <RuleFormDialog open onOpenChange={() => undefined} rule={rule(over)} periods={[1, 7]} />,
    { session: sessionAs({ activeTenant: ACTIVE, tenants: [ACTIVE], isProviderAdmin: false }) },
  );
  await flush(5);
  return document.querySelector<HTMLTextAreaElement>("#rule-recipients");
}

describe("the recipients field of a rule", () => {
  it("is read-only for a rule that carries a category of the notification recipients, and says where to change them", async () => {
    const field = await open({ recipientCategory: "jobFailures" });
    expect(field?.readOnly).toBe(true);
    expect(field?.value).toBe("ops@example.test");
    expect(document.body.textContent).toContain("Change them there.");
  });

  it("stays editable for a rule made by hand", async () => {
    const field = await open({ recipientCategory: null });
    expect(field?.readOnly).toBe(false);
  });
});

describe("the deadline for missing backups", () => {
  it("is not offered for a rule without backup.overdue", async () => {
    await open({ events: ["backup.failed"] });
    expect(document.querySelector('[data-slot="overdue-deadline"]')).toBeNull();
  });

  it("shows the rule's own hours for a rule with backup.overdue", async () => {
    await open({ events: ["backup.overdue"], overdueAfterHours: 96 });
    expect(document.querySelector('[data-slot="overdue-deadline"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Deadline for missing backups");
    expect(document.body.textContent).toContain("Own deadline");
    expect(document.querySelector<HTMLInputElement>("#rule-overdue-hours")?.value).toBe("96");
  });

  it("follows the schedules for a rule without a deadline of its own", async () => {
    await open({ events: ["backup.overdue"], overdueAfterHours: null });
    expect(document.body.textContent).toContain("By the backup jobs' schedules");
    expect(document.querySelector("#rule-overdue-hours")).toBeNull();
  });
});

describe("the period of a report (0.5.0)", () => {
  const schedule: Partial<ReportRule> = {
    trigger: "schedule",
    events: [],
    cron: "0 7 1 * *",
    periodDays: 30,
    sections: ["backups"],
    inApp: true,
    emailRecipients: [],
  };

  async function openSchedule(over: Partial<ReportRule>, pdfAvailable: boolean) {
    const { mock, requests } = routedFetch({
      "GET /webhooks": () => json([]),
      "PATCH /reports/rules/r-1": (request) =>
        json(rule({ ...schedule, ...over, ...(request.body as object) })),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(
      <RuleFormDialog
        open
        onOpenChange={() => undefined}
        rule={rule({ ...schedule, ...over })}
        periods={[1, 7, 30]}
        pdfAvailable={pdfAvailable}
      />,
      { session: sessionAs({ activeTenant: ACTIVE, tenants: [ACTIVE], isProviderAdmin: false }) },
    );
    await flush(5);
    return { requests };
  }

  const pdfSwitch = () => document.querySelector<HTMLButtonElement>("#rule-attach-pdf");

  it("shows a calendar cadence without the own schedule and period fields", async () => {
    await openSchedule({ cadence: "monthly", attachPdf: true }, true);
    expect(document.querySelector("#rule-cadence")?.textContent).toContain("Previous month");
    expect(document.body.textContent).toContain("Sent on the 1st at 07:00");
    expect(document.querySelector("#rule-frequency")).toBeNull();
    expect(document.querySelector("#rule-period")).toBeNull();
    expect(pdfSwitch()?.getAttribute("aria-checked")).toBe("true");
  });

  it("shows the own schedule for a rule without a cadence", async () => {
    await openSchedule({ cadence: null }, true);
    expect(document.querySelector("#rule-cadence")?.textContent).toContain("Own interval or cron");
    expect(document.querySelector("#rule-frequency")).not.toBeNull();
    expect(document.querySelector("#rule-period")).not.toBeNull();
  });

  it("saves the cadence and the PDF switch", async () => {
    const { requests } = await openSchedule({ cadence: "weekly", attachPdf: false }, true);
    await click(pdfSwitch());
    await click(buttonByText(document.body, "Save"));
    await flush(5);
    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.body).toMatchObject({ cadence: "weekly", attachPdf: true, cron: null });
  });

  it("closes the PDF switch where the statistics are not available, and saves it off", async () => {
    const { requests } = await openSchedule({ cadence: "weekly", attachPdf: true }, false);
    expect(pdfSwitch()?.hasAttribute("disabled")).toBe(true);
    expect(pdfSwitch()?.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain(
      "The PDF statistics are not available on this installation.",
    );
    await click(buttonByText(document.body, "Save"));
    await flush(5);
    expect(requests.find((request) => request.method === "PATCH")?.body).toMatchObject({
      attachPdf: false,
    });
  });
});
