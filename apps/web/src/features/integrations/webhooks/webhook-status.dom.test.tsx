// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { WebhookHealth } from "@/features/reports/api";
import { enableActEnvironment, flush, type Mounted, mount } from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "../i18n.js";
import { WebhookFailingBadge, WebhookHealthBanner } from "./webhook-status";

/**
 * A webhook whose deliveries keep failing (0.5.0): the list marks it, and its page says since
 * when, how many attempts in a row, the last error and when the alert went out through the
 * other channels. A webhook that delivers shows neither.
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

const FAILING: WebhookHealth = {
  status: "failing",
  failingSince: "2026-11-05T07:00:00.000Z",
  consecutiveFailures: 4,
  lastError: "http_error 500: Internal Server Error",
  alertedAt: "2026-11-05T07:30:00.000Z",
};

async function show(health: WebhookHealth | undefined) {
  mounted = mount(
    <>
      <WebhookFailingBadge webhook={{ health }} />
      <WebhookHealthBanner webhook={{ health }} />
    </>,
  );
  await flush(2);
}

describe("the health of a webhook", () => {
  it("shows the banner with attempts, the last error and the alert, and the list badge", async () => {
    await show(FAILING);
    const banner = document.querySelector("[data-slot=webhook-health-banner]");
    expect(banner?.textContent).toContain(i18n.t("integrations:detail.health.title"));
    expect(banner?.textContent).toContain("4");
    expect(banner?.querySelector("code")?.textContent).toBe(
      "http_error 500: Internal Server Error",
    );
    expect(banner?.textContent).toContain(
      i18n.t("integrations:detail.health.alerted", {
        at: new Date(FAILING.alertedAt ?? "").toLocaleString("en", {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      }),
    );
    expect(document.querySelector("[data-slot=webhook-failing]")).not.toBeNull();
  });

  it("says when no alert went out yet", async () => {
    await show({ ...FAILING, alertedAt: null, lastError: null });
    const banner = document.querySelector("[data-slot=webhook-health-banner]");
    expect(banner?.textContent).toContain(i18n.t("integrations:detail.health.notAlerted"));
    expect(banner?.querySelector("code")).toBeNull();
  });

  it("shows nothing while the webhook delivers, or for an older server", async () => {
    await show({
      status: "ok",
      failingSince: null,
      consecutiveFailures: 0,
      lastError: null,
      alertedAt: null,
    });
    expect(document.querySelector("[data-slot=webhook-health-banner]")).toBeNull();
    expect(document.querySelector("[data-slot=webhook-failing]")).toBeNull();
    await mounted?.unmount();
    await show(undefined);
    expect(document.querySelector("[data-slot=webhook-health-banner]")).toBeNull();
  });
});
