import { describe, expect, it } from "vitest";
import { FakeMailboxGraph } from "../testing/fake-mailbox.js";
import {
  clientStateMatches,
  createSubscriptions,
  deleteSubscription,
  hashClientState,
  IMMUTABLE_ID_PREFER,
  mailSubscriptionResource,
  needsRenewal,
  newClientState,
  parseChangeNotifications,
  parseLifecycleNotifications,
  reauthorizeSubscription,
  renewalDueAt,
  renewSubscriptions,
  subscriptionExpiry,
  verifyNotifications,
} from "./subscriptions.js";

const SUB = "6f1b8c2e-3d4a-4b5c-9d8e-7f6a5b4c3d2e";

function spec(user: string, clientState = newClientState()) {
  return {
    resource: mailSubscriptionResource(user),
    notificationUrl: "https://restow.example/api/v1/hooks/graph/notifications",
    lifecycleNotificationUrl: "https://restow.example/api/v1/hooks/graph/lifecycle",
    clientState,
    expirationDateTime: subscriptionExpiry(new Date("2026-11-02T08:00:00Z")),
  };
}

describe("clientState", () => {
  it("is random, stored as SHA-256 and compared exactly", () => {
    const a = newClientState();
    expect(a).not.toBe(newClientState());
    expect(a.length).toBeLessThanOrEqual(128);
    const hash = hashClientState(a);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(clientStateMatches(a, hash)).toBe(true);
    expect(clientStateMatches(`${a}x`, hash)).toBe(false);
    expect(clientStateMatches("", hash)).toBe(false);
    expect(clientStateMatches(undefined, hash)).toBe(false);
    expect(clientStateMatches(42, hash)).toBe(false);
    expect(clientStateMatches(a, "not-hex")).toBe(false);
  });
});

describe("expiry and renewal", () => {
  it("asks for 4230 minutes and renews with less than a day left", () => {
    const now = new Date("2026-11-02T08:00:00Z");
    const expiry = subscriptionExpiry(now);
    expect(expiry.getTime() - now.getTime()).toBe(4230 * 60_000);
    expect(needsRenewal(expiry, now)).toBe(false);
    expect(needsRenewal(expiry, renewalDueAt(expiry))).toBe(false);
    expect(needsRenewal(expiry, new Date(renewalDueAt(expiry).getTime() + 1))).toBe(true);
  });
});

describe("subscriptions against the fake Graph", () => {
  it("creates through $batch with immutable ids, renews, reauthorizes and deletes", async () => {
    const fake = new FakeMailboxGraph();
    const client = fake.client();
    const results = await createSubscriptions(
      client,
      Array.from({ length: 23 }, (_, n) => spec(`user-${n}`)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(fake.subscriptions.size).toBe(23);
    // 23 creations: two $batch requests (20 + 3).
    expect(fake.graph.callsTo("POST", "/$batch")).toHaveLength(2);
    const created = [...fake.subscriptions.values()];
    expect(created.every((s) => s.prefer === IMMUTABLE_ID_PREFER)).toBe(true);
    expect(created[0]?.resource).toBe("users/user-0/messages");
    expect(created[0]?.changeType).toBe("created");

    const first = results[0];
    if (!first?.ok) {
      throw new Error("expected a subscription");
    }
    const later = new Date("2026-11-05T08:00:00Z");
    const [renewed, gone] = await renewSubscriptions(client, [
      { id: first.subscription.id, expirationDateTime: later },
      { id: SUB, expirationDateTime: later },
    ]);
    expect(renewed?.ok && renewed.subscription.expirationDateTime.toISOString()).toBe(
      later.toISOString(),
    );
    expect(gone?.ok).toBe(false);
    expect(!gone?.ok && gone?.error.status).toBe(404);

    await reauthorizeSubscription(client, first.subscription.id);
    await deleteSubscription(client, first.subscription.id);
    await deleteSubscription(client, first.subscription.id); // 404 counts as deleted
    expect(fake.subscriptions.has(first.subscription.id)).toBe(false);
    await expect(reauthorizeSubscription(client, SUB)).rejects.toMatchObject({ status: 404 });
  });

  it("reports a failed notification URL validation per subscription", async () => {
    const fake = new FakeMailboxGraph({ validate: () => 500 });
    const [result] = await createSubscriptions(fake.client(), [spec("anna")]);
    expect(result?.ok).toBe(false);
    expect(!result?.ok && result?.error.status).toBe(400);
  });
});

describe("notification parsing", () => {
  it("reads change notifications and counts malformed ones", () => {
    const { notifications, invalid } = parseChangeNotifications({
      value: [
        {
          subscriptionId: SUB.toUpperCase(),
          clientState: "secret",
          changeType: "created",
          resource: "Users/u1/Messages/AAMk1",
          resourceData: { id: "AAMk1", "@odata.type": "#Microsoft.Graph.Message" },
          tenantId: "t1",
        },
        { subscriptionId: SUB, resource: "Users/u1/Messages('AAMk2')" },
        { subscriptionId: "not-a-guid" },
        "nonsense",
      ],
    });
    expect(invalid).toBe(2);
    expect(notifications).toEqual([
      {
        subscriptionId: SUB,
        clientState: "secret",
        changeType: "created",
        resource: "Users/u1/Messages/AAMk1",
        resourceId: "AAMk1",
        tenantId: "t1",
      },
      expect.objectContaining({ resourceId: "AAMk2", clientState: null }),
    ]);
    expect(parseChangeNotifications({}).notifications).toEqual([]);
    expect(parseChangeNotifications(null).invalid).toBe(1);
  });

  it("reads lifecycle notifications, unknown events are invalid", () => {
    const { notifications, invalid } = parseLifecycleNotifications({
      value: [
        { subscriptionId: SUB, lifecycleEvent: "missed", clientState: "s" },
        { subscriptionId: SUB, lifecycleEvent: "subscriptionRemoved" },
        { subscriptionId: SUB, lifecycleEvent: "somethingNew" },
      ],
    });
    expect(invalid).toBe(1);
    expect(notifications.map((n) => n.lifecycleEvent)).toEqual(["missed", "subscriptionRemoved"]);
  });

  it("accepts only notifications whose clientState matches their subscription", () => {
    const secret = newClientState();
    const known = new Map([[SUB, { clientStateHash: hashClientState(secret) }]]);
    const { accepted, rejected } = verifyNotifications(
      [
        { subscriptionId: SUB, clientState: secret },
        { subscriptionId: SUB, clientState: "wrong" },
        { subscriptionId: SUB, clientState: null },
        { subscriptionId: "11111111-2222-3333-4444-555555555555", clientState: secret },
      ],
      known,
    );
    expect(accepted).toHaveLength(1);
    expect(rejected).toBe(3);
  });
});
