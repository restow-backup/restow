import { describe, expect, it } from "vitest";
import { GraphError, isMailboxUnavailable } from "./errors.js";

function error(status: number, code: string): GraphError {
  return new GraphError({
    status,
    method: "GET",
    url: "https://graph.microsoft.com/v1.0/users/u/mailboxSettings",
    payload: { error: { code, message: "x" } },
  });
}

describe("isMailboxUnavailable", () => {
  it("knows the codes the failure classifier reads as a mailbox that is not enabled", () => {
    for (const code of [
      "MailboxNotEnabledForRESTAPI",
      "ErrorMailboxNotEnabledForRESTAPI",
      "MailboxNotHostedInExchangeOnline",
      "ErrorMailboxNotHostedInExchangeOnline",
      "MailboxNotSupportedForRESTAPI",
    ]) {
      expect(isMailboxUnavailable(error(404, code)), code).toBe(true);
    }
    expect(isMailboxUnavailable(error(403, "ErrorAccessDenied"))).toBe(false);
  });
});
