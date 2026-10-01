import type { MessageEnvelopeObject, MessageStructureObject } from "imapflow";
import { describe, expect, it } from "vitest";
import { noopLogger } from "../../engine/logger.js";
import { BlockedAddressError } from "../../net/address-policy.js";
import { ImapFlowConnector, buildClientOptions, deriveEnvelopeMeta } from "./imapflow-connector.js";
import { type ImapAccountConfig, ImapAuthError, ImapConfigError } from "./types.js";

const account: ImapAccountConfig = {
  host: "imap.example.test",
  port: 993,
  security: "tls",
  username: "alice@example.test",
  authKind: "password",
  secretId: "s",
};

describe("buildClientOptions", () => {
  it("maps transport security onto imapflow without leaving a downgrade path", () => {
    expect(buildClientOptions(account, { kind: "password", password: "p" })).toMatchObject({
      host: "imap.example.test",
      port: 993,
      secure: true,
      auth: { user: "alice@example.test", pass: "p" },
      logger: false,
      disableAutoIdle: true,
    });
    expect(
      buildClientOptions(
        { ...account, port: 143, security: "starttls" },
        { kind: "password", password: "p" },
      ),
    ).toMatchObject({ secure: false, doSTARTTLS: true });
    expect(
      buildClientOptions(
        { ...account, port: 143, security: "none" },
        { kind: "password", password: "p" },
      ),
    ).toMatchObject({ secure: false, doSTARTTLS: false });
  });

  it("passes OAuth2 access tokens as SASL credentials", () => {
    expect(buildClientOptions(account, { kind: "oauth2", accessToken: "tok" }).auth).toEqual({
      user: "alice@example.test",
      accessToken: "tok",
    });
  });

  it("carries the SASL authzid for master-user impersonation, only alongside a password", () => {
    const masterAccount = { ...account, username: "master", authzid: "mailbox@example.test" };
    expect(buildClientOptions(masterAccount, { kind: "password", password: "p" }).auth).toEqual({
      user: "master",
      pass: "p",
      authzid: "mailbox@example.test",
      loginMethod: "AUTH=PLAIN",
    });
    // No authzid at all for a plain account: the shape (and any server that is
    // strict about unknown SASL fields) stays exactly as before this existed.
    expect(buildClientOptions(account, { kind: "password", password: "p" }).auth).toEqual({
      user: "alice@example.test",
      pass: "p",
    });
    // OAuth2 has no SASL PLAIN authzid to carry (XOAUTH2 has no such field).
    expect(buildClientOptions(masterAccount, { kind: "oauth2", accessToken: "tok" }).auth).toEqual({
      user: "master",
      accessToken: "tok",
    });
  });

  it("forces AUTH=PLAIN when authzid is set, so a server without it fails loudly instead of silently dropping impersonation", () => {
    // imapflow only threads authzid through AUTH=PLAIN. Without loginMethod forced,
    // a server that advertises AUTH=LOGIN but not AUTH=PLAIN would fall back to
    // AUTH=LOGIN and sign in as the master account itself, unimpersonated, with no
    // error at all - a data-integrity failure, not just a login failure.
    const masterAccount = { ...account, username: "master", authzid: "mailbox@example.test" };
    const options = buildClientOptions(masterAccount, { kind: "password", password: "p" });
    expect(options.auth).toMatchObject({ loginMethod: "AUTH=PLAIN" });
  });

  it("resolves every host through the guarded lookup", () => {
    const options = buildClientOptions(account, { kind: "password", password: "p" });
    expect(typeof options.tls?.lookup).toBe("function");
  });

  it("refuses private and local hosts unless the operator allowed them", () => {
    const password = { kind: "password", password: "p" } as const;
    for (const host of ["10.0.0.5", "127.0.0.1", "postgres", "mail.internal"]) {
      expect(() => buildClientOptions({ ...account, host }, password)).toThrow(ImapConfigError);
      expect(
        buildClientOptions({ ...account, host, allowPrivateNetwork: true }, password).host,
      ).toBe(host);
    }
  });

  it("never connects to link-local addresses such as the cloud metadata service", () => {
    expect(() =>
      buildClientOptions(
        { ...account, host: "169.254.169.254", allowPrivateNetwork: true },
        { kind: "password", password: "p" },
      ),
    ).toThrow(ImapConfigError);
  });
});

describe("ImapFlowConnector.connect", () => {
  function fakeClient(behaviour: {
    connect: () => Promise<void>;
    secure?: boolean;
    capabilities?: Map<string, boolean>;
  }) {
    let loggedOut = false;
    return {
      secureConnection: behaviour.secure ?? true,
      capabilities: behaviour.capabilities ?? new Map<string, boolean>(),
      usable: true,
      mailbox: false,
      connect: behaviour.connect,
      logout: async () => {
        loggedOut = true;
      },
      get loggedOut() {
        return loggedOut;
      },
      close: () => {},
      on: () => undefined,
      once: () => undefined,
    };
  }

  it("translates authentication failures", async () => {
    const connector = new ImapFlowConnector({
      createClient: () =>
        fakeClient({
          connect: async () => {
            throw Object.assign(new Error("Authentication failed"), {
              authenticationFailed: true,
              response: "NO [AUTHENTICATIONFAILED] Invalid credentials",
            });
          },
        }) as never,
    });
    await expect(
      connector.connect(
        account,
        { kind: "password", password: "p" },
        { logger: noopLogger, signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(ImapAuthError);
  });

  it("refuses a session that ended up unencrypted", async () => {
    const connector = new ImapFlowConnector({
      createClient: () => fakeClient({ connect: async () => {}, secure: false }) as never,
    });
    await expect(
      connector.connect(
        { ...account, security: "starttls", port: 143 },
        { kind: "password", password: "p" },
        { logger: noopLogger, signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(ImapConfigError);
  });

  it("refuses a session where a master-user authzid login was silently dropped", async () => {
    // Regression: imapflow only attempts SASL (where authzid, and the forced
    // loginMethod: "AUTH=PLAIN", would apply) when the server advertises
    // AUTH=LOGIN or AUTH=PLAIN. A server advertising neither makes imapflow
    // fall back to the plain IMAP LOGIN command regardless of loginMethod,
    // which has no authzid at all: the client that just connected is
    // authenticated as the master account itself, not impersonating the
    // target mailbox, with no error from imapflow. The connector must catch
    // this from `client.capabilities` and refuse the session rather than
    // hand back one authenticated as the wrong identity.
    const client = fakeClient({ connect: async () => {}, capabilities: new Map() });
    const connector = new ImapFlowConnector({ createClient: () => client as never });
    const masterAccount = { ...account, username: "master", authzid: "mailbox@example.test" };
    await expect(
      connector.connect(
        masterAccount,
        { kind: "password", password: "p" },
        { logger: noopLogger, signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(ImapConfigError);
    expect(client.loggedOut).toBe(true);
  });

  it("proceeds with a master-user authzid login once the server actually offers AUTH=PLAIN", async () => {
    const client = fakeClient({
      connect: async () => {},
      capabilities: new Map([["AUTH=PLAIN", true]]),
    });
    const connector = new ImapFlowConnector({ createClient: () => client as never });
    const masterAccount = { ...account, username: "master", authzid: "mailbox@example.test" };
    await expect(
      connector.connect(
        masterAccount,
        { kind: "password", password: "p" },
        { logger: noopLogger, signal: new AbortController().signal },
      ),
    ).resolves.toBeDefined();
    expect(client.loggedOut).toBe(false);
  });

  it("never runs the authzid check for a login without authzid", async () => {
    const client = fakeClient({ connect: async () => {}, capabilities: new Map() });
    const connector = new ImapFlowConnector({ createClient: () => client as never });
    await expect(
      connector.connect(
        account,
        { kind: "password", password: "p" },
        { logger: noopLogger, signal: new AbortController().signal },
      ),
    ).resolves.toBeDefined();
    expect(client.loggedOut).toBe(false);
  });

  it("translates a missing STARTTLS into a configuration error", async () => {
    const connector = new ImapFlowConnector({
      createClient: () =>
        fakeClient({
          connect: async () => {
            throw Object.assign(new Error("Server does not support STARTTLS"), { tlsFailed: true });
          },
        }) as never,
    });
    await expect(
      connector.connect(
        { ...account, security: "starttls", port: 143 },
        { kind: "password", password: "p" },
        { logger: noopLogger, signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(ImapConfigError);
  });

  it("reports a name that resolved into a private network as a configuration error", async () => {
    const connector = new ImapFlowConnector({
      createClient: () =>
        fakeClient({
          connect: async () => {
            throw new BlockedAddressError("imap.example.test");
          },
        }) as never,
    });
    await expect(
      connector.connect(
        account,
        { kind: "password", password: "p" },
        { logger: noopLogger, signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(ImapConfigError);
  });
});

describe("deriveEnvelopeMeta", () => {
  const envelope = (overrides: Partial<MessageEnvelopeObject> = {}): MessageEnvelopeObject => ({
    subject: "Quarterly numbers",
    from: [{ name: "Alice Example", address: "alice@example.test" }],
    to: [{ name: "Bob Example", address: "bob@example.test" }],
    cc: [],
    date: new Date("2026-09-20T08:00:00Z"),
    ...overrides,
  });

  const textPlain: MessageStructureObject = { type: "text/plain" };

  it("returns undefined when the server did not answer with an envelope", () => {
    expect(deriveEnvelopeMeta(undefined, textPlain)).toBeUndefined();
  });

  it("formats subject, from, to, cc and the envelope date, with hasAttachments false for a plain message", () => {
    const meta = deriveEnvelopeMeta(envelope(), textPlain);
    expect(meta).toEqual({
      subject: "Quarterly numbers",
      from: "Alice Example <alice@example.test>",
      to: ["Bob Example <bob@example.test>"],
      toCount: 1,
      cc: [],
      ccCount: 0,
      hasAttachments: false,
      sentDateTime: new Date("2026-09-20T08:00:00Z"),
      protection: null,
    });
  });

  it("falls back to the bare address, or the bare name for a group marker with no address", () => {
    const meta = deriveEnvelopeMeta(
      envelope({
        from: [{ address: "noreply@example.test" }],
        to: [{ name: "undisclosed-recipients" }],
      }),
      textPlain,
    );
    expect(meta?.from).toBe("noreply@example.test");
    expect(meta?.to).toEqual(["undisclosed-recipients"]);
  });

  it("quotes a display name that contains a comma so the formatted list still splits unambiguously", () => {
    const meta = deriveEnvelopeMeta(
      envelope({
        from: [{ name: "Flores, Lucas", address: "lucas@example.test" }],
        to: [{ name: "Doe, John", address: "john@example.test" }],
      }),
      textPlain,
    );
    expect(meta?.from).toBe('"Flores, Lucas" <lucas@example.test>');
    expect(meta?.to).toEqual(['"Doe, John" <john@example.test>']);
  });

  it("caps the formatted to/cc lists at 20 entries while keeping the full count", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      name: `Recipient ${i}`,
      address: `r${i}@example.test`,
    }));
    const meta = deriveEnvelopeMeta(envelope({ to: many, cc: many }), textPlain);
    expect(meta?.to).toHaveLength(20);
    expect(meta?.toCount).toBe(25);
    expect(meta?.to[0]).toBe("Recipient 0 <r0@example.test>");
    expect(meta?.cc).toHaveLength(20);
    expect(meta?.ccCount).toBe(25);
  });

  describe("hasAttachments from BODYSTRUCTURE", () => {
    it("is false for multipart/alternative text and HTML with no other parts", () => {
      const structure: MessageStructureObject = {
        type: "multipart/alternative",
        childNodes: [{ type: "text/plain" }, { type: "text/html" }],
      };
      expect(deriveEnvelopeMeta(envelope(), structure)?.hasAttachments).toBe(false);
    });

    it("is true when a leaf part is marked as an attachment", () => {
      const structure: MessageStructureObject = {
        type: "multipart/mixed",
        childNodes: [
          { type: "text/plain" },
          { type: "application/pdf", disposition: "attachment", part: "2" },
        ],
      };
      expect(deriveEnvelopeMeta(envelope(), structure)?.hasAttachments).toBe(true);
    });

    it("does not count an inline image referenced by Content-ID as an attachment", () => {
      const structure: MessageStructureObject = {
        type: "multipart/related",
        childNodes: [
          { type: "text/html" },
          { type: "image/png", disposition: "inline", id: "<logo>", part: "2" },
        ],
      };
      expect(deriveEnvelopeMeta(envelope(), structure)?.hasAttachments).toBe(false);
    });

    it("is true for a non-text leaf with no Content-ID even without a disposition", () => {
      const structure: MessageStructureObject = {
        type: "multipart/mixed",
        childNodes: [{ type: "text/plain" }, { type: "application/octet-stream", part: "2" }],
      };
      expect(deriveEnvelopeMeta(envelope(), structure)?.hasAttachments).toBe(true);
    });

    it("is true for a forwarded message kept as its own message/rfc822 part", () => {
      const structure: MessageStructureObject = {
        type: "multipart/mixed",
        childNodes: [
          { type: "text/plain" },
          {
            type: "message/rfc822",
            disposition: "attachment",
            dispositionParameters: { filename: "Fwd: Quarterly numbers.eml" },
            part: "2",
            // A message/rfc822 part carries the forwarded message's own body structure;
            // this must not be walked into before the disposition above is checked.
            childNodes: [{ type: "text/plain" }],
          },
        ],
      };
      expect(deriveEnvelopeMeta(envelope(), structure)?.hasAttachments).toBe(true);
    });

    it("is false for a meeting invite's text/calendar alternative", () => {
      const structure: MessageStructureObject = {
        type: "multipart/alternative",
        childNodes: [{ type: "text/plain" }, { type: "text/calendar" }],
      };
      expect(deriveEnvelopeMeta(envelope(), structure)?.hasAttachments).toBe(false);
    });

    it("is false for the detached signature of a clear-signed message", () => {
      const structure: MessageStructureObject = {
        type: "multipart/signed",
        childNodes: [
          { type: "text/plain" },
          { type: "application/pkcs7-signature", dispositionParameters: { filename: "smime.p7s" } },
        ],
      };
      expect(deriveEnvelopeMeta(envelope(), structure)?.hasAttachments).toBe(false);
    });
  });

  describe("protection from BODYSTRUCTURE", () => {
    it("flags a top-level rights-protected (rpmsg) message", () => {
      const structure: MessageStructureObject = { type: "application/x-microsoft-rpmsg-message" };
      expect(deriveEnvelopeMeta(envelope(), structure)?.protection).toBe("rights-protected");
    });

    it("flags a message wrapping the protected content as a message.rpmsg attachment", () => {
      const structure: MessageStructureObject = {
        type: "multipart/mixed",
        childNodes: [
          { type: "text/plain" },
          {
            type: "application/octet-stream",
            disposition: "attachment",
            dispositionParameters: { filename: "message.rpmsg" },
            part: "2",
          },
        ],
      };
      expect(deriveEnvelopeMeta(envelope(), structure)?.protection).toBe("rights-protected");
    });

    it("flags S/MIME enveloped data by smime-type", () => {
      const structure: MessageStructureObject = {
        type: "application/pkcs7-mime",
        parameters: { "smime-type": "enveloped-data" },
      };
      expect(deriveEnvelopeMeta(envelope(), structure)?.protection).toBe("smime-encrypted");
    });

    it("flags S/MIME enveloped data by the conventional smime.p7m name when smime-type is absent", () => {
      const structure: MessageStructureObject = {
        type: "application/x-pkcs7-mime",
        parameters: { name: "smime.p7m" },
      };
      expect(deriveEnvelopeMeta(envelope(), structure)?.protection).toBe("smime-encrypted");
    });

    it("does not flag a signed-only S/MIME message", () => {
      const structure: MessageStructureObject = {
        type: "multipart/signed",
        childNodes: [
          { type: "text/plain" },
          {
            type: "application/pkcs7-signature",
            dispositionParameters: { filename: "smime.p7s" },
            part: "2",
          },
        ],
      };
      expect(deriveEnvelopeMeta(envelope(), structure)?.protection).toBeNull();
    });

    it("does not flag opaque-signed S/MIME even though it conventionally names the part smime.p7m", () => {
      // RFC 8551 3.5.2: opaque signing is application/pkcs7-mime with smime-type=signed-data,
      // using the same smime.p7m name enveloped (encrypted) data conventionally uses.
      const structure: MessageStructureObject = {
        type: "application/pkcs7-mime",
        parameters: { "smime-type": "signed-data", name: "smime.p7m" },
      };
      expect(deriveEnvelopeMeta(envelope(), structure)?.protection).toBeNull();
    });

    it("leaves an ordinary message unflagged", () => {
      expect(deriveEnvelopeMeta(envelope(), textPlain)?.protection).toBeNull();
    });
  });
});

describe("ImapFlowSession.fetchMeta", () => {
  function fakeFetchClient(
    fetchAll: (uids: number[], query: Record<string, unknown>) => Promise<unknown[]>,
  ) {
    return {
      secureConnection: true,
      usable: true,
      mailbox: false,
      connect: async () => {},
      logout: async () => {},
      close: () => {},
      on: () => undefined,
      once: () => undefined,
      fetchAll,
    };
  }

  async function sessionWith(
    fetchAll: (uids: number[], query: Record<string, unknown>) => Promise<unknown[]>,
  ) {
    const connector = new ImapFlowConnector({
      createClient: () => fakeFetchClient(fetchAll) as never,
    });
    return connector.connect(
      account,
      { kind: "password", password: "p" },
      { logger: noopLogger, signal: new AbortController().signal },
    );
  }

  it("falls back to the old field set when ENVELOPE/BODYSTRUCTURE makes the server refuse the batch", async () => {
    const queries: Record<string, unknown>[] = [];
    const session = await sessionWith(async (uids, query) => {
      queries.push(query);
      if ("envelope" in query) {
        throw Object.assign(new Error("NO could not process the requested items"), {});
      }
      return uids.map((uid) => ({
        uid,
        size: 42,
        flags: ["\\Seen"],
        internalDate: new Date("2026-09-20T08:00:00Z"),
      }));
    });

    const metas = await session.fetchMeta([1]);

    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({ envelope: true, bodyStructure: true });
    expect(queries[1]).not.toHaveProperty("envelope");
    expect(queries[1]).not.toHaveProperty("bodyStructure");
    expect(metas).toEqual([
      {
        uid: 1,
        size: 42,
        flags: ["\\Seen"],
        internalDate: new Date("2026-09-20T08:00:00Z"),
        messageId: null,
        envelope: undefined,
      },
    ]);
  });

  it("does not retry, and reports connectionLost, when the connection itself is gone", async () => {
    let calls = 0;
    const connector = new ImapFlowConnector({
      createClient: () => {
        const client = fakeFetchClient(async () => {
          calls++;
          client.usable = false;
          throw new Error("read ECONNRESET");
        });
        return client as never;
      },
    });
    const session = await connector.connect(
      account,
      { kind: "password", password: "p" },
      { logger: noopLogger, signal: new AbortController().signal },
    );

    await expect(session.fetchMeta([1])).rejects.toMatchObject({
      name: "ImapSessionError",
      connectionLost: true,
    });
    expect(calls).toBe(1);
  });
});
