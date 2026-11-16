// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { enableActEnvironment, flush, type Mounted, mount } from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { DeliveryProblems } from "./reports-page";

/**
 * A rule whose channels fail right now (0.5.0) says so in its row: the address the mail server
 * refuses and the webhook that keeps failing, each with since when and why in words.
 */

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

describe("DeliveryProblems", () => {
  it("lists a failing address and a failing webhook with their reasons", async () => {
    mounted = mount(
      <DeliveryProblems
        rule={{
          deliveryProblems: [
            {
              channel: "email",
              recipient: "ops@contoso.example",
              since: "2026-11-05T08:00:00.000Z",
              reason: "recipient_rejected",
            },
            {
              channel: "webhook",
              recipient: "11111111-1111-4111-8111-111111111111",
              since: "2026-11-05T07:00:00.000Z",
              reason: "timeout",
            },
          ],
        }}
      />,
    );
    await flush(2);
    const alert = document.querySelector("[data-slot=rule-delivery-problems]");
    const items = [...(alert?.querySelectorAll("li") ?? [])].map((item) => item.textContent ?? "");
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("ops@contoso.example");
    expect(items[0]).toContain(i18n.t("settings:mail.test.reasons.recipient_rejected"));
    expect(items[1]).toContain(i18n.t("integrations:deliveries.errors.timeout"));
  });

  it("shows nothing while every channel gets through", async () => {
    mounted = mount(<DeliveryProblems rule={{ deliveryProblems: [] }} />);
    await flush(2);
    expect(document.querySelector("[data-slot=rule-delivery-problems]")).toBeNull();
  });
});
