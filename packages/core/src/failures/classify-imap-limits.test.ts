/**
 * IMAP refusals that clear by themselves (connection limits at login, download or command
 * caps on reads) are `imap.server_limit`, transient: not wrong credentials, not a full
 * mailbox.
 */
import { describe, expect, it } from "vitest";
import { ImapSessionError } from "../backup/imap/types.js";
import { isLoginRefusalCause } from "../directory/login-refused.js";
import { classifyFailure } from "./classify.js";

function imapflowError(props: Record<string, unknown>): Error {
  return Object.assign(new Error("Command failed"), props);
}

describe("IMAP limits", () => {
  it("a login refused for too many connections is a server limit, not wrong credentials", () => {
    const login = imapflowError({
      authenticationFailed: true,
      serverResponseCode: "ALERT",
      response: "Too many simultaneous connections. (Failure)",
      executedCommand: '1 LOGIN "alice@example.test" "s3cret"',
    });
    // As the connector hands it on: a transient session error with imapflow's error as cause.
    const wrapped = new ImapSessionError("login temporarily refused", true, { cause: login });
    for (const error of [login, wrapped]) {
      const cause = classifyFailure(error, { role: "imap", host: "imap.example.test" });
      expect(cause.code).toBe("imap.server_limit");
      expect(cause.transient).toBe(true);
      expect(JSON.stringify(cause)).not.toContain("s3cret");
    }
  });

  it("an auth backend that is down ([UNAVAILABLE]) is a server limit", () => {
    const cause = classifyFailure(
      imapflowError({
        authenticationFailed: true,
        serverResponseCode: "UNAVAILABLE",
        response: "Temporary authentication failure.",
      }),
    );
    expect(cause.code).toBe("imap.server_limit");
  });

  it("[AUTHENTICATIONFAILED] stays wrong credentials", () => {
    const cause = classifyFailure(
      imapflowError({
        authenticationFailed: true,
        serverResponseCode: "AUTHENTICATIONFAILED",
        response: "Invalid credentials (Failure)",
      }),
    );
    expect(cause.code).toBe("imap.auth_failed");
    expect(isLoginRefusalCause(cause)).toBe(true);
  });

  it("a temporary refusal is not a login refusal for the question", () => {
    const cause = classifyFailure(
      imapflowError({
        authenticationFailed: true,
        serverResponseCode: "UNAVAILABLE",
        response: "Temporary authentication failure.",
      }),
    );
    expect(isLoginRefusalCause(cause)).toBe(false);
  });

  it("OVERQUOTA or LIMIT on a read is a server limit, not a full mailbox", () => {
    for (const [code, command] of [
      ["OVERQUOTA", "1F UID FETCH 1:* BODY.PEEK[]"],
      ["LIMIT", "A UID FETCH 1:50 BODY.PEEK[]"],
      ["OVERQUOTA", "2B EXAMINE INBOX"],
    ] as const) {
      const cause = classifyFailure(
        imapflowError({
          responseStatus: "NO",
          responseText: "Account exceeded download limits",
          serverResponseCode: code,
          executedCommand: command,
        }),
      );
      expect(cause.code).toBe("imap.server_limit");
      expect(cause.transient).toBe(true);
      expect(cause.params).toMatchObject({ imapCode: code });
    }
  });

  it("OVERQUOTA on an append (a restore) is still a full mailbox", () => {
    const cause = classifyFailure(
      imapflowError({
        responseStatus: "NO",
        responseText: "Quota exceeded (mailbox for user is full)",
        serverResponseCode: "OVERQUOTA",
        executedCommand: "C APPEND INBOX {120}",
      }),
    );
    expect(cause.code).toBe("imap.mailbox_full");
  });

  it("LIMIT on an append (a message too large) is a permanent command failure", () => {
    const cause = classifyFailure(
      imapflowError({
        responseStatus: "NO",
        responseText: "Message too large",
        serverResponseCode: "LIMIT",
        executedCommand: "C APPEND INBOX {120}",
      }),
    );
    expect(cause.code).toBe("imap.command_failed");
    expect(cause.transient).toBe(false);
    expect(cause.params).toMatchObject({ imapCode: "LIMIT" });
  });
});
