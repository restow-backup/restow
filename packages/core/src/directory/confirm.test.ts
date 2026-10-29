import { describe, expect, it } from "vitest";
import type { BatchRequest, BatchResponse, GraphClient } from "../graph/client.js";
import { confirmMailboxInactive } from "./confirm.js";

interface Answer {
  readonly status: number;
  readonly body?: unknown;
}

/** A Graph client whose `$batch` answers the user read and the mailbox probe as given. */
function graph(user: Answer, mailbox: Answer, seen: BatchRequest[][] = []): GraphClient {
  return {
    async batch(requests: BatchRequest[]): Promise<BatchResponse[]> {
      seen.push(requests);
      return requests.map((request) => ({
        id: request.id,
        ...(request.id === "user" ? user : mailbox),
      }));
    },
  } as unknown as GraphClient;
}

const enabled: Answer = { status: 200, body: { accountEnabled: true, userType: "Member" } };
const disabled: Answer = { status: 200, body: { accountEnabled: false, userType: "Member" } };
const notEnabled = (status: number): Answer => ({
  status,
  body: {
    error: { code: "MailboxNotEnabledForRESTAPI", message: "REST API is not yet supported" },
  },
});

describe("confirmMailboxInactive", () => {
  it("confirms an existing user without a mailbox, naming why", async () => {
    const seen: BatchRequest[][] = [];
    await expect(
      confirmMailboxInactive(graph(disabled, { status: 404 }, seen), "user-1"),
    ).resolves.toEqual({ reason: "account_disabled" });
    expect(seen[0]?.map((request) => request.url)).toEqual([
      "/users/user-1?$select=accountEnabled%2Cmail%2CuserType",
      "/users/user-1/mailboxSettings",
    ]);
    await expect(
      confirmMailboxInactive(graph(enabled, notEnabled(400)), "user-1"),
    ).resolves.toEqual({ reason: "no_license" });
    await expect(
      confirmMailboxInactive(graph(enabled, notEnabled(404)), "user-1"),
    ).resolves.toEqual({ reason: "no_license" });
  });

  it("never reads a permission problem as inactive", async () => {
    const denied: Answer = { status: 403, body: { error: { code: "ErrorAccessDenied" } } };
    await expect(confirmMailboxInactive(graph(enabled, denied), "user-1")).resolves.toBeNull();
    await expect(
      confirmMailboxInactive(graph(enabled, notEnabled(403)), "user-1"),
    ).resolves.toBeNull();
    await expect(
      confirmMailboxInactive(graph(enabled, { status: 401 }), "user-1"),
    ).resolves.toBeNull();
  });

  it("does not confirm when the mailbox answers, the user is gone or Graph is busy", async () => {
    await expect(
      confirmMailboxInactive(graph(disabled, { status: 200, body: {} }), "user-1"),
    ).resolves.toBeNull();
    await expect(
      confirmMailboxInactive(graph({ status: 404 }, { status: 404 }), "user-1"),
    ).resolves.toBeNull();
    await expect(
      confirmMailboxInactive(graph(enabled, { status: 429 }), "user-1"),
    ).resolves.toBeNull();
    await expect(
      confirmMailboxInactive(graph(enabled, { status: 503 }), "user-1"),
    ).resolves.toBeNull();
    const guest: Answer = { status: 200, body: { accountEnabled: true, userType: "Guest" } };
    await expect(
      confirmMailboxInactive(graph(guest, { status: 404 }), "user-1"),
    ).resolves.toBeNull();
    const failing = {
      batch: async () => {
        throw new Error("network down");
      },
    } as unknown as GraphClient;
    await expect(confirmMailboxInactive(failing, "user-1")).resolves.toBeNull();
  });
});
