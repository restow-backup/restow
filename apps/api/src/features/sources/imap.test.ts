import { describe, expect, it } from "vitest";
import {
  type ImapProbeClient,
  type ImapProbeInput,
  classifyImapError,
  imapFlowOptions,
  probeImapConnection,
} from "./imap.js";

const input: ImapProbeInput = {
  host: "imap.example.com",
  port: 993,
  security: "tls",
  username: "alice@example.com",
  password: "s3cret-value",
};

function fakeClient(
  behaviour: Partial<ImapProbeClient> & { connectError?: unknown; hang?: boolean } = {},
): ImapProbeClient & { closed: number; loggedOut: number } {
  const client = {
    closed: 0,
    loggedOut: 0,
    serverInfo: behaviour.serverInfo ?? { name: "Dovecot", version: "2.3" },
    capabilities:
      behaviour.capabilities ??
      new Map<string, boolean | number>([
        ["IMAP4rev1", true],
        ["IDLE", true],
        ["CONDSTORE", true],
        ["X-CUSTOM", true],
      ]),
    secureConnection: behaviour.secureConnection ?? true,
    async connect() {
      if (behaviour.hang) {
        await new Promise(() => undefined);
      }
      if (behaviour.connectError !== undefined) {
        throw behaviour.connectError;
      }
    },
    async list() {
      return [{ specialUse: "\\Sent" }, { specialUse: "\\Trash" }, { specialUse: "\\Sent" }, {}];
    },
    async logout() {
      client.loggedOut += 1;
    },
    close() {
      client.closed += 1;
    },
  };
  return client;
}

describe("imapFlowOptions", () => {
  it("maps tls / starttls / none onto imapflow's transport switches", () => {
    expect(imapFlowOptions(input, 5000)).toMatchObject({ secure: true, host: "imap.example.com" });
    expect(imapFlowOptions({ ...input, security: "starttls" }, 5000)).toMatchObject({
      secure: false,
      doSTARTTLS: true,
    });
    expect(imapFlowOptions({ ...input, security: "none" }, 5000)).toMatchObject({
      secure: false,
      doSTARTTLS: false,
    });
  });

  it("carries the SASL authzid for a master-user login test, never without a password", () => {
    // loginMethod is forced to AUTH=PLAIN whenever authzid is set: imapflow only
    // threads authzid through that mechanism, and without forcing it a server that
    // advertises AUTH=LOGIN but not AUTH=PLAIN would silently drop the authzid and
    // test the master account's own login instead of the impersonated mailbox.
    expect(imapFlowOptions({ ...input, authzid: "mailbox@example.com" }, 5000).auth).toEqual({
      user: input.username,
      pass: input.password,
      authzid: "mailbox@example.com",
      loginMethod: "AUTH=PLAIN",
    });
    expect(imapFlowOptions(input, 5000).auth).toEqual({
      user: input.username,
      pass: input.password,
    });
  });

  it("bounds every phase by the probe timeout and never logs", () => {
    const options = imapFlowOptions(input, 5000);
    expect(options.connectionTimeout).toBe(5000);
    expect(options.greetingTimeout).toBe(5000);
    expect(options.socketTimeout).toBe(5000);
    expect(options.logger).toBe(false);
    expect(options.disableAutoIdle).toBe(true);
    expect(options.auth).toEqual({ user: input.username, pass: input.password });
  });
});

describe("classifyImapError", () => {
  it("recognises authentication failures by imapflow's marker", () => {
    expect(
      classifyImapError({ authenticationFailed: true, message: "Authentication failed" }),
    ).toEqual({
      reason: "auth",
      code: null,
    });
    expect(classifyImapError({ code: "AUTHENTICATIONFAILED" })).toMatchObject({ reason: "auth" });
  });

  it("maps socket and imapflow codes", () => {
    expect(classifyImapError({ code: "ENOTFOUND" })).toMatchObject({ reason: "dns" });
    expect(classifyImapError({ code: "ECONNREFUSED" })).toMatchObject({ reason: "refused" });
    expect(classifyImapError({ code: "CONNECT_TIMEOUT" })).toMatchObject({ reason: "timeout" });
    expect(classifyImapError({ code: "GREETING_TIMEOUT" })).toMatchObject({ reason: "timeout" });
    expect(classifyImapError({ code: "CERT_HAS_EXPIRED" })).toMatchObject({ reason: "tls" });
    expect(classifyImapError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).toMatchObject({
      reason: "tls",
    });
    expect(classifyImapError({ message: "Server does not support STARTTLS" })).toMatchObject({
      reason: "starttls_unavailable",
    });
    expect(classifyImapError(new Error("boom"))).toEqual({ reason: "unknown", code: null });
    expect(classifyImapError("string")).toEqual({ reason: "unknown", code: null });
  });
});

describe("probeImapConnection", () => {
  it("reports server, folders, special-use and interesting capabilities on success", async () => {
    const client = fakeClient();
    const result = await probeImapConnection(input, {
      createClient: () => client,
      now: () => new Date("2026-09-22T10:00:00Z"),
    });
    expect(result).toEqual({
      ok: true,
      checkedAt: "2026-09-22T10:00:00.000Z",
      secure: true,
      server: { name: "Dovecot", vendor: null, version: "2.3" },
      mailboxes: 4,
      specialUse: ["\\Sent", "\\Trash"],
      capabilities: ["IMAP4rev1", "IDLE", "CONDSTORE"],
    });
    expect(client.loggedOut).toBe(1);
    expect(client.closed).toBe(1);
  });

  it("classifies failures and never leaks the password", async () => {
    const error = Object.assign(new Error("Authentication failed"), {
      authenticationFailed: true,
      responseText: "[AUTHENTICATIONFAILED] Invalid credentials",
    });
    const client = fakeClient({ connectError: error });
    const result = await probeImapConnection(input, {
      createClient: () => client,
      now: () => new Date("2026-09-22T10:00:00Z"),
    });
    expect(result).toEqual({
      ok: false,
      checkedAt: "2026-09-22T10:00:00.000Z",
      reason: "auth",
      code: null,
      message: "Authentication failed; [AUTHENTICATIONFAILED] Invalid credentials",
    });
    expect(JSON.stringify(result)).not.toContain(input.password);
    expect(client.closed).toBe(1);
  });

  it("gives up after the timeout and closes the socket", async () => {
    const client = fakeClient({ hang: true });
    const result = await probeImapConnection(input, { createClient: () => client, timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, reason: "timeout", code: "PROBE_TIMEOUT" });
    expect(client.closed).toBe(1);
  });

  it("refuses private and local hosts without opening a connection", async () => {
    for (const host of ["127.0.0.1", "10.0.0.8", "169.254.169.254", "postgres", "db.internal"]) {
      let created = false;
      const result = await probeImapConnection(
        { ...input, host },
        {
          createClient: () => {
            created = true;
            return fakeClient();
          },
          now: () => new Date("2026-09-22T10:00:00Z"),
        },
      );
      expect(result).toMatchObject({
        ok: false,
        reason: "blocked_address",
        code: "BLOCKED_ADDRESS",
      });
      expect(result.ok ? "" : result.message).not.toContain(host);
      expect(created).toBe(false);
    }
  });

  it("lets the operator's consent reach private networks, never link-local ones", async () => {
    const allowed = await probeImapConnection(
      { ...input, host: "10.0.0.8" },
      { allowPrivateNetworks: true, createClient: () => fakeClient() },
    );
    expect(allowed.ok).toBe(true);
    const metadata = await probeImapConnection(
      { ...input, host: "169.254.169.254" },
      { allowPrivateNetworks: true, createClient: () => fakeClient() },
    );
    expect(metadata).toMatchObject({ ok: false, reason: "blocked_address" });
  });

  it("reports a name that resolved into a private network without what answered there", async () => {
    const blocked = Object.assign(new Error("connections to imap.example.com are not allowed"), {
      code: "BLOCKED_ADDRESS",
    });
    const result = await probeImapConnection(input, {
      createClient: () => fakeClient({ connectError: blocked }),
    });
    expect(result).toMatchObject({ ok: false, reason: "blocked_address", code: "BLOCKED_ADDRESS" });
  });

  it("fails an authzid probe when the server never actually offered AUTH=PLAIN", async () => {
    // Regression: forcing loginMethod: "AUTH=PLAIN" (imapFlowOptions) only
    // matters once imapflow decides to attempt SASL at all, which it only
    // does when the server advertises AUTH=LOGIN or AUTH=PLAIN. A server
    // advertising neither makes imapflow fall back to the plain IMAP LOGIN
    // command, silently dropping authzid and testing the master account's
    // own login as a false "success" instead of the impersonated mailbox.
    const client = fakeClient({ capabilities: new Map([["IMAP4rev1", true]]) });
    const result = await probeImapConnection(
      { ...input, username: "master", authzid: "mailbox@example.com" },
      { createClient: () => client, now: () => new Date("2026-09-22T10:00:00Z") },
    );
    expect(result).toMatchObject({ ok: false, reason: "auth", code: "AUTHZID_UNSUPPORTED" });
    expect(result.ok ? "" : result.message).toContain("AUTH=PLAIN");
    expect(client.loggedOut).toBe(1);
    expect(client.closed).toBe(1);
  });

  it("proceeds with an authzid probe once the server actually offers AUTH=PLAIN", async () => {
    const client = fakeClient({ capabilities: new Map([["AUTH=PLAIN", true]]) });
    const result = await probeImapConnection(
      { ...input, username: "master", authzid: "mailbox@example.com" },
      { createClient: () => client, now: () => new Date("2026-09-22T10:00:00Z") },
    );
    expect(result.ok).toBe(true);
  });

  it("resolves the host through the guarded lookup", () => {
    expect(typeof imapFlowOptions(input, 5000).tls?.lookup).toBe("function");
  });

  it("passes the translated options to the client factory", async () => {
    let seen: unknown;
    await probeImapConnection(
      { ...input, security: "starttls", port: 143 },
      {
        createClient: (options) => {
          seen = options;
          return fakeClient();
        },
      },
    );
    expect(seen).toMatchObject({ port: 143, secure: false, doSTARTTLS: true });
  });
});
