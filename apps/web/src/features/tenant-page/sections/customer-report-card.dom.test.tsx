// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CustomerReportSettings } from "@/features/reports/customer-report-api";
import {
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  type Mounted,
  mount,
  routedFetch,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "../i18n";
import { CustomerReportCard } from "./customer-report-card";

/**
 * The customer monthly report of a tenant (Service Provider): below it the card names the
 * edition and offers nothing; with it, the day, hour and language change at once, the contacts
 * who receive it are listed, and a closed page shows the settings without changing them.
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

const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const base = `/tenants/${TENANT_ID}/customer-report`;

const SETTINGS: CustomerReportSettings = {
  available: true,
  enabled: true,
  sendDay: 3,
  sendHour: 8,
  timezone: "Europe/Berlin",
  language: null,
  recipients: [{ contactId: "c1", name: "Alice Admin", email: "alice@contoso.example" }],
  nextRunAt: "2026-12-03T07:00:00.000Z",
  lastRunAt: null,
  lastDelivery: null,
};

async function open(
  settings: Partial<CustomerReportSettings>,
  {
    readOnly = false,
    routes = {},
  }: { readOnly?: boolean; routes?: Parameters<typeof routedFetch>[0] } = {},
) {
  const { mock, requests } = routedFetch({
    [`GET ${base}`]: () => json({ ...SETTINGS, ...settings }),
    ...routes,
  });
  vi.stubGlobal("fetch", mock);
  mounted = mount(<CustomerReportCard tenantId={TENANT_ID} readOnly={readOnly} />);
  await flush(6);
  return { requests };
}

async function select(id: string, value: string) {
  const element = document.querySelector<HTMLSelectElement>(`#${id}`);
  if (!element) throw new Error(`no select ${id}`);
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await flush(3);
}

describe("CustomerReportCard", () => {
  it("names the edition and offers nothing below Service Provider", async () => {
    await open({ available: false });
    const card = document.querySelector("[data-slot=customer-report]");
    expect(card?.getAttribute("data-locked")).toBe("true");
    expect(card?.querySelector("[data-slot=feature-locked]")?.getAttribute("data-feature")).toBe(
      "reports.customer",
    );
    expect(document.querySelector("#customer-report-enabled")).toBeNull();
  });

  it("lists the contacts who receive it and saves the day at once", async () => {
    const { requests } = await open(
      {},
      {
        routes: {
          [`PUT ${base}`]: (request) => json({ ...SETTINGS, ...(request.body as object) }),
        },
      },
    );
    expect(document.querySelector("[data-slot=customer-report-recipients]")?.textContent).toContain(
      "alice@contoso.example",
    );
    expect(document.querySelector<HTMLSelectElement>("#customer-report-day")?.value).toBe("3");
    expect(document.querySelectorAll("#customer-report-day option")).toHaveLength(28);
    await select("customer-report-day", "15");
    await select("customer-report-language", "de");
    expect(requests.filter((request) => request.method === "PUT").map((r) => r.body)).toEqual([
      { sendDay: 15 },
      { language: "de" },
    ]);
  });

  it("shows the settings without changing them on a closed page", async () => {
    await open({}, { readOnly: true });
    expect(document.querySelector<HTMLButtonElement>("#customer-report-enabled")?.disabled).toBe(
      true,
    );
    expect(document.querySelector<HTMLSelectElement>("#customer-report-day")?.disabled).toBe(true);
    expect(document.querySelector<HTMLSelectElement>("#customer-report-hour")?.disabled).toBe(true);
  });
});
