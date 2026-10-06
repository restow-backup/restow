// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { adminSession } from "@/features/backup-jobs/testing";
import {
  type Mounted,
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  mount,
  newQueryClient,
  routedFetch,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "../i18n.js";
import type { Webhook, WebhookWithSecret } from "../types.js";
import { WebhookFormDialog } from "./webhook-form-dialog.js";

/**
 * The webhook form picks the format from the URL as it is typed (Discord,
 * Slack, Teams), keeps a format chosen by hand, creates a chat webhook
 * without revealing a secret, and reveals a fresh one when a chat webhook is
 * switched to the signed format.
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

const HOOK_ID = "22222222-2222-4222-8222-222222222222";

function webhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: HOOK_ID,
    name: null,
    url: "https://discord.com/api/webhooks/1/token",
    events: ["job.failed"],
    active: true,
    format: "discord",
    secretConfigured: true,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
    stats: { pending: 0, failedLast24h: 0, deliveredLast24h: 0, lastDelivery: null },
    ...overrides,
  };
}

function withSecret(hook: Webhook): WebhookWithSecret {
  return { ...hook, secret: "whsec_fresh" };
}

async function open(
  routes: Parameters<typeof routedFetch>[0],
  props: Partial<React.ComponentProps<typeof WebhookFormDialog>> = {},
) {
  const { mock, requests } = routedFetch(routes);
  vi.stubGlobal("fetch", mock);
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  mounted = mount(
    <WebhookFormDialog open onOpenChange={onOpenChange} onCreated={onCreated} {...props} />,
    { session: adminSession(), queryClient: newQueryClient() },
  );
  await flush(4);
  return { requests, onOpenChange, onCreated };
}

const urlInput = () => document.querySelector("#webhook-url");
const formatTrigger = () => document.querySelector("#webhook-format");

describe("WebhookFormDialog", () => {
  it("recognises the chat service from the URL and follows the URL as it changes", async () => {
    await open({});
    expect(formatTrigger()?.textContent).toContain("Restow JSON (signed)");
    await type(urlInput(), "https://discord.com/api/webhooks/123/abc");
    await flush(2);
    expect(formatTrigger()?.textContent).toContain("Discord");
    expect(document.body.textContent).toContain("Recognised from the URL.");
    expect(document.body.textContent).toContain("sent without one and no secret is shown");
    await type(urlInput(), "https://hooks.slack.com/services/T/B/x");
    await flush(2);
    expect(formatTrigger()?.textContent).toContain("Slack");
    await type(
      urlInput(),
      "https://prod-1.westeurope.logic.azure.com/workflows/x/triggers/manual/paths/invoke",
    );
    await flush(2);
    expect(formatTrigger()?.textContent).toContain("Microsoft Teams");
    await type(urlInput(), "https://rmm.example.com/hooks");
    await flush(2);
    expect(formatTrigger()?.textContent).toContain("Restow JSON (signed)");
  });

  it("creates a chat webhook with its format and no secret to reveal", async () => {
    const created = withSecret(webhook());
    const { requests, onCreated } = await open({
      "POST /webhooks": () => json(created, 201),
    });
    await type(urlInput(), "https://discord.com/api/webhooks/1/token");
    await flush(2);
    await click(buttonByText(document.body, "Add webhook"));
    await flush(6);
    const post = requests.find((request) => request.method === "POST");
    expect(post?.body).toMatchObject({
      url: "https://discord.com/api/webhooks/1/token",
      format: "discord",
      events: ["job.failed"],
    });
    expect(document.body.textContent).not.toContain("Copy the signing secret now");
    expect([...document.querySelectorAll("input")].map((input) => input.value)).not.toContain(
      "whsec_fresh",
    );
    expect(onCreated).toHaveBeenCalledWith(HOOK_ID);
  });

  it("keeps a format that differs from the URL when the webhook is edited", async () => {
    const { requests } = await open(
      { "PATCH /webhooks/22222222-2222-4222-8222-222222222222": () => json(webhook()) },
      { webhook: webhook({ url: "https://discord.com/api/webhooks/1/token", format: "restow" }) },
    );
    expect(formatTrigger()?.textContent).toContain("Restow JSON (signed)");
    await type(urlInput(), "https://discord.com/api/webhooks/2/other");
    await flush(2);
    // Chosen deliberately before: stays.
    expect(formatTrigger()?.textContent).toContain("Restow JSON (signed)");
    await click(buttonByText(document.body, "Save changes"));
    await flush(6);
    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.body).toEqual({ url: "https://discord.com/api/webhooks/2/other" });
  });

  it("reveals a new secret when a chat webhook switches to the signed format", async () => {
    const { requests } = await open(
      {
        "PATCH /webhooks/22222222-2222-4222-8222-222222222222": () =>
          json(webhook({ url: "https://rmm.example.com/hooks", format: "restow" })),
        "POST /webhooks/22222222-2222-4222-8222-222222222222/secret": () =>
          json(withSecret(webhook({ url: "https://rmm.example.com/hooks", format: "restow" }))),
      },
      { webhook: webhook() },
    );
    await type(urlInput(), "https://rmm.example.com/hooks");
    await flush(2);
    expect(formatTrigger()?.textContent).toContain("Restow JSON (signed)");
    expect(document.body.textContent).toContain("creates a new signing secret");
    await click(buttonByText(document.body, "Save changes"));
    await flush(6);
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `PATCH /webhooks/${HOOK_ID}`,
      `POST /webhooks/${HOOK_ID}/secret`,
    ]);
    expect(requests[0]?.body).toEqual({ url: "https://rmm.example.com/hooks", format: "restow" });
    expect(document.body.textContent).toContain("Copy the signing secret now");
    const shown = [...document.querySelectorAll("input")].map((input) => input.value);
    expect(shown).toContain("whsec_fresh");
  });
});
