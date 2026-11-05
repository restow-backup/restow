// @vitest-environment happy-dom
import { act } from "react";
import { useForm } from "react-hook-form";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { RecipientFailure } from "@/features/reports/api";
import { enableActEnvironment, flush, type Mounted, mount } from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "../../i18n";
import {
  emptyTenantWizardForm,
  type TenantWizardRecipientValues,
  type TenantWizardValues,
} from "../../forms";
import { NotificationsStep } from "./step-notifications";

/**
 * The tenant page's recipients (0.5.0): per recipient the digest mode per severity, the daily,
 * weekly and monthly summary reports (closed without timed reports) and a sign when mail to the
 * address fails. The wizard keeps its plain form.
 */

enableActEnvironment();

let mounted: Mounted | null = null;
let current: TenantWizardValues | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  current = null;
  document.body.innerHTML = "";
});

const RECIPIENT: TenantWizardRecipientValues = {
  email: "ops@contoso.example",
  name: "",
  events: ["backup.failed", "report.weekly"],
  delivery: { error: "immediate", warning: "hourly", info: "immediate" },
};

function Harness({
  extended,
}: {
  extended?: { summaryAvailable: boolean; failures: Record<string, RecipientFailure> };
}) {
  const form = useForm<TenantWizardValues>({
    defaultValues: { ...emptyTenantWizardForm("en"), notificationRecipients: [RECIPIENT] },
  });
  current = form.watch();
  return <NotificationsStep form={form} canOpenInstallation={false} extended={extended} />;
}

async function show(extended?: Parameters<typeof Harness>[0]["extended"]) {
  mounted = mount(<Harness extended={extended} />);
  await flush(3);
}

async function select(element: HTMLSelectElement | null | undefined, value: string) {
  if (!element) throw new Error("no select");
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("NotificationsStep on the tenant page", () => {
  it("offers the delivery modes and the three summary reports, and records a change", async () => {
    await show({ summaryAvailable: true, failures: {} });
    const selects = [
      ...document.querySelectorAll<HTMLSelectElement>("[data-slot=recipient-delivery]"),
    ];
    expect(selects.map((element) => [element.dataset.level, element.value])).toEqual([
      ["error", "immediate"],
      ["warning", "hourly"],
      ["info", "immediate"],
    ]);
    await select(selects[2], "daily");
    await flush(2);
    expect(current?.notificationRecipients[0]?.delivery).toEqual({
      error: "immediate",
      warning: "hourly",
      info: "daily",
    });

    const summaries = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-slot=recipient-summary]"),
    ];
    expect(summaries.map((box) => [box.dataset.entry, box.getAttribute("aria-checked")])).toEqual([
      ["report.daily", "false"],
      ["report.weekly", "true"],
      ["report.monthly", "false"],
    ]);
    await act(async () => summaries[2]?.click());
    await flush(2);
    expect(current?.notificationRecipients[0]?.events).toEqual([
      "backup.failed",
      "report.weekly",
      "report.monthly",
    ]);
    expect(document.body.textContent).toContain("Critical");
  });

  it("closes the summary reports without timed reports and names the edition", async () => {
    await show({ summaryAvailable: false, failures: {} });
    const summaries = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-slot=recipient-summary]"),
    ];
    expect(summaries.every((box) => box.hasAttribute("disabled"))).toBe(true);
    expect(
      document
        .querySelector("[data-slot=summary-locked] [data-slot=feature-locked]")
        ?.getAttribute("data-feature"),
    ).toBe("reports.timed");
  });

  it("marks an address whose mail fails, with the reason in words", async () => {
    await show({
      summaryAvailable: true,
      failures: {
        "ops@contoso.example": {
          since: "2026-11-05T08:00:00.000Z",
          reason: "recipient_rejected",
          detail: "550 5.1.1",
        },
      },
    });
    const badge = document.querySelector("[data-slot=recipient-failure]");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain(i18n.t("settings:mail.test.reasons.recipient_rejected"));
  });

  it("keeps the wizard's plain form", async () => {
    await show(undefined);
    expect(document.querySelector("[data-slot=recipient-delivery]")).toBeNull();
    expect(document.querySelector("[data-slot=recipient-summary]")).toBeNull();
  });
});
