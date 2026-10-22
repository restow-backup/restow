import { JobAbortedError, mailSubscriptionResource, newClientState } from "@restow/core";
import { describe, expect, it } from "vitest";
import { FakeMailboxGraph } from "../../../../packages/core/src/graph/testing/fake-mailbox.js";
import {
  graphWaySettingsFromEnv,
  notificationTarget,
  SubscriptionBatcher,
  subscriptionAppFingerprint,
} from "./graph.js";

function spec(n: number) {
  return {
    kind: "create" as const,
    spec: {
      resource: mailSubscriptionResource(`user-${n}`),
      notificationUrl: "https://restow.example.com/api/v1/hooks/graph/notifications",
      lifecycleNotificationUrl: "https://restow.example.com/api/v1/hooks/graph/lifecycle",
      clientState: newClientState(),
      expirationDateTime: new Date(Date.now() + 86_400_000),
    },
  };
}

describe("notificationTarget", () => {
  it("needs a public HTTPS URL on the standard port", () => {
    expect(notificationTarget("https://restow.example.com/some/path")).toEqual({
      ok: true,
      notificationUrl: "https://restow.example.com/api/v1/hooks/graph/notifications",
      lifecycleUrl: "https://restow.example.com/api/v1/hooks/graph/lifecycle",
    });
    expect(notificationTarget("https://restow.example.com:443").ok).toBe(true);
    for (const url of [
      null,
      "",
      "not a url",
      "http://restow.example.com",
      "https://restow.example.com:8443",
      "https://localhost",
      "https://backup.local",
      "https://10.0.0.5",
      "https://192.168.1.10",
      "https://172.20.0.2",
      "https://127.0.0.1",
      "https://[::1]",
    ]) {
      expect(notificationTarget(url), String(url)).toEqual({
        ok: false,
        reason: "graph.notification_url_unavailable",
      });
    }
  });
});

describe("graph way settings", () => {
  it("reads the catch-up intervals", () => {
    expect(graphWaySettingsFromEnv({})).toEqual({ catchUpMinutes: 360, pollMinutes: 15 });
    expect(
      graphWaySettingsFromEnv({
        ARCHIVE_GRAPH_CATCHUP_MINUTES: "120",
        ARCHIVE_GRAPH_POLL_MINUTES: "x",
      }),
    ).toEqual({ catchUpMinutes: 120, pollMinutes: 15 });
  });
});

describe("subscriptionAppFingerprint", () => {
  it("follows the app, not its secret", () => {
    const a = subscriptionAppFingerprint({ clientId: "app-1" });
    expect(subscriptionAppFingerprint({ clientId: "app-1", authorityHost: undefined })).toBe(a);
    expect(subscriptionAppFingerprint({ clientId: "app-2" })).not.toBe(a);
  });
});

describe("SubscriptionBatcher", () => {
  it("sends at most 20 per $batch and one $batch per interval and tenant", async () => {
    const fake = new FakeMailboxGraph();
    const client = fake.client();
    const signal = new AbortController().signal;
    const batcher = new SubscriptionBatcher({ windowMs: 5, minIntervalMs: 40 });
    const started = Date.now();
    const results = await Promise.all([
      ...Array.from({ length: 45 }, (_, n) => batcher.submit("tenant-a", client, signal, spec(n))),
      batcher.submit("tenant-b", client, signal, spec(99)),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fake.subscriptions.size).toBe(46);
    const batches = fake.graph.callsTo("POST", "/$batch");
    const sizes = batches.map((call) => (call.json as { requests: unknown[] }).requests.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
    // tenant-a: 20 + 20 + 5 in three batches, at least two intervals apart; tenant-b alone.
    expect(sizes.sort((x, y) => x - y)).toEqual([1, 5, 20, 20]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });

  it("does not send the request of an aborted pass", async () => {
    const fake = new FakeMailboxGraph();
    const controller = new AbortController();
    const batcher = new SubscriptionBatcher({ windowMs: 20, minIntervalMs: 0 });
    const pending = batcher.submit("t", fake.client(), controller.signal, spec(1));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(JobAbortedError);
    expect(fake.graph.calls).toHaveLength(0);
  });
});
