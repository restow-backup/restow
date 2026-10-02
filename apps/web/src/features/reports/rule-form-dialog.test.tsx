// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Mounted,
  enableActEnvironment,
  flush,
  json,
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
