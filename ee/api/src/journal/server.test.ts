import type { AddressInfo } from "node:net";
import { archive } from "@restow/core";
import type { Database } from "@restow/db";
import nodemailer from "nodemailer";
import type { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../../../apps/api/src/config.js";
import type { ArchiveDelivery, ArchiveReceipt, JournalReceiverDeps } from "./receiver.js";
import type { ArchiveRecipient } from "./recipient.js";
import {
  createInMemoryRateLimiter,
  createJournalServer,
  type JournalServerOptions,
  type JournalServerTls,
} from "./server.js";
import { certificate, fingerprint, rawSmtp } from "./tls-test-support.js";

/**
 * The receiver's SMTP protocol behaviour: accept a
 * known journal address, reject an unknown one at RCPT TO, and reply 451 (not
 * 250) when the archive write fails, so Exchange Online retries. And its TLS
 * contract: with a certificate, mail is refused (530) until the client has
 * issued STARTTLS and the certificate served is the configured one; without
 * one (the explicit development opt-out), STARTTLS is not offered at all.
 * Exercised against a real TCP connection with `nodemailer` and a raw SMTP
 * client, the recipient lookup and `receive` faked so this never touches Postgres
 * or storage. The certificates are throwaway ones generated here. Since 0.4.4 also:
 * account addresses next to the tenant's, one tenant per transaction (452), the
 * per-address limit (451) and what the receiver gets of the SMTP envelope.
 */

const config: Pick<Config["journal"], "hostname" | "maxSizeBytes"> = {
  hostname: "archive.example.com",
  maxSizeBytes: 10 * 1024 * 1024,
};

const serverCertificate = certificate();
const tlsMode: JournalServerTls = {
  mode: "tls",
  key: Buffer.from(serverCertificate.keyPem),
  cert: Buffer.from(serverCertificate.certPem),
};

const fakeReceiverDeps = {} as JournalReceiverDeps;
const fakeProviderDb = {} as Database;

let server: SMTPServer | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

async function start(options: {
  /** The tenant of a journal address (shorthand for {@link resolveRecipient}). */
  resolveTenant?: (providerDb: Database, address: string) => Promise<string | null>;
  resolveRecipient?: (providerDb: Database, address: string) => Promise<ArchiveRecipient | null>;
  receive: (
    tenantId: string,
    raw: Buffer,
    delivery: ArchiveDelivery,
  ) => Promise<archive.ArchiveItemRecord | ArchiveReceipt>;
  tls?: JournalServerTls;
  logger?: JournalServerOptions["logger"];
  addressRateLimiter?: JournalServerOptions["addressRateLimiter"];
}): Promise<number> {
  const resolveTenant = options.resolveTenant ?? (async () => null);
  server = createJournalServer({
    config,
    tls: options.tls ?? tlsMode,
    providerDb: fakeProviderDb,
    receiverDeps: fakeReceiverDeps,
    rateLimiter: createInMemoryRateLimiter(1000),
    ...(options.addressRateLimiter ? { addressRateLimiter: options.addressRateLimiter } : {}),
    resolveRecipient:
      options.resolveRecipient ??
      (async (db, address) => {
        const tenantId = await resolveTenant(db, address);
        return tenantId ? { kind: "tenant", tenantId } : null;
      }),
    receive: async (delivery, raw) => {
      const result = await options.receive(delivery.tenantId, raw, delivery);
      return "itemId" in result
        ? result
        : { kind: "journal_report", outcome: "stored", itemId: result.id, flags: result.flags };
    },
    ...(options.logger ? { logger: options.logger } : {}),
  });
  await new Promise<void>((resolve) => server?.listen(0, resolve));
  return (server as unknown as { server: { address(): AddressInfo } }).server.address().port;
}

function transportFor(port: number) {
  return nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    tls: { rejectUnauthorized: false },
  });
}

const fakeRecord: archive.ArchiveItemRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  tenantId: "22222222-2222-2222-2222-222222222222",
  receivedAt: new Date("2026-01-01T00:00:00Z"),
  itemHash: "a".repeat(64),
  prevChainHash: null,
  chainHash: "b".repeat(64),
  size: 10,
  chunks: [],
  envelope: null,
  flags: [],
  source: "journal",
  legalHold: false,
  retentionUntil: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("journal SMTP receiver", () => {
  it("accepts mail for a known journal address and commits it before replying", async () => {
    const received: string[] = [];
    const port = await start({
      resolveTenant: async (_db, address) =>
        address === "journal+known@archive.example.com" ? fakeRecord.tenantId : null,
      receive: async (tenantId, raw) => {
        received.push(`${tenantId}:${raw.length}`);
        return fakeRecord;
      },
    });

    await transportFor(port).sendMail({
      from: "journal@tenant.onmicrosoft.com",
      to: "journal+known@archive.example.com",
      subject: "test",
      text: "hello",
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toContain(fakeRecord.tenantId);
  });

  it("rejects an unknown journal address at RCPT TO, before any body is read", async () => {
    let receiveCalled = false;
    const port = await start({
      resolveTenant: async () => null,
      receive: async () => {
        receiveCalled = true;
        return fakeRecord;
      },
    });

    await expect(
      transportFor(port).sendMail({
        from: "journal@tenant.onmicrosoft.com",
        to: "journal+unknown@archive.example.com",
        subject: "test",
        text: "hello",
      }),
    ).rejects.toThrow();

    expect(receiveCalled).toBe(false);
  });

  it("replies temporary failure (not success) when the archive write fails, so the sender retries", async () => {
    const port = await start({
      resolveTenant: async () => fakeRecord.tenantId,
      receive: async () => {
        throw new Error("storage unavailable");
      },
    });

    let caught: unknown;
    try {
      await transportFor(port).sendMail({
        from: "journal@tenant.onmicrosoft.com",
        to: "journal+known@archive.example.com",
        subject: "test",
        text: "hello",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const message = caught instanceof Error ? caught.message : String(caught);
    // nodemailer surfaces the SMTP response code from the rejected DATA command.
    expect(message).toMatch(/451/);
  });

  it("asks the sender to retry (451) when every parser process is busy, and logs no content", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const port = await start({
      resolveTenant: async () => fakeRecord.tenantId,
      receive: async () => {
        throw new archive.JournalParserBusyError();
      },
      logger,
    });

    const caught = await transportFor(port)
      .sendMail({
        from: "journal@tenant.onmicrosoft.com",
        to: "journal+known@archive.example.com",
        subject: "Confidential merger plans",
        text: "hello",
      })
      .catch((error: unknown) => error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toMatch(/451/);
    expect(message).toMatch(/busy/);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("busy"), {
      tenantId: fakeRecord.tenantId,
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("merger");
  });

  it("accepts a report archived without its details and logs why, never what it said", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const flagged: archive.ArchiveItemRecord = {
      ...fakeRecord,
      flags: ["report-parse-timeout", "original-message-missing"],
    };
    const port = await start({
      resolveTenant: async () => fakeRecord.tenantId,
      receive: async () => flagged,
      logger,
    });

    await transportFor(port).sendMail({
      from: "journal@tenant.onmicrosoft.com",
      to: "journal+known@archive.example.com",
      subject: "Confidential merger plans",
      text: "hello",
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [text, fields] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(text).toContain("archived byte for byte without its details");
    expect(fields).toMatchObject({
      tenantId: fakeRecord.tenantId,
      itemId: fakeRecord.id,
      flags: ["report-parse-timeout", "original-message-missing"],
    });
    expect(fields.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("merger");
  });
});

const acceptAll = {
  resolveTenant: async () => fakeRecord.tenantId,
  receive: async () => fakeRecord,
};

describe("journal SMTP receiver, TLS with a certificate", () => {
  it("offers STARTTLS and serves the configured certificate, never smtp-server's built-in one", async () => {
    const port = await start(acceptAll);
    const session = await rawSmtp(port);
    const ehlo = await session.send("EHLO exchange.example.test");
    expect(ehlo.text).toContain("STARTTLS");
    expect((await session.send("STARTTLS")).code).toBe(220);
    const presented = await session.upgrade();
    expect(presented).toBe(fingerprint(serverCertificate.certPem));
    session.close();
  });

  it("refuses MAIL FROM in plain text with 530 and accepts it after STARTTLS", async () => {
    const port = await start(acceptAll);
    const session = await rawSmtp(port);
    await session.send("EHLO exchange.example.test");

    const plain = await session.send("MAIL FROM:<journal@tenant.onmicrosoft.com>");
    expect(plain.code).toBe(530);
    expect(plain.text).toContain("Must issue a STARTTLS command first");
    // No recipient and no data are ever taken in the clear.
    expect((await session.send("RCPT TO:<journal+known@archive.example.com>")).code).toBe(503);

    expect((await session.send("STARTTLS")).code).toBe(220);
    await session.upgrade();
    await session.send("EHLO exchange.example.test");
    expect((await session.send("MAIL FROM:<journal@tenant.onmicrosoft.com>")).code).toBe(250);
    expect((await session.send("RCPT TO:<journal+known@archive.example.com>")).code).toBe(250);
    session.close();
  });

  it("delivers for a client that verifies the certificate against its name", async () => {
    const received: number[] = [];
    const port = await start({
      resolveTenant: async () => fakeRecord.tenantId,
      receive: async (_tenantId, raw) => {
        received.push(raw.length);
        return fakeRecord;
      },
    });
    await nodemailer
      .createTransport({
        host: "127.0.0.1",
        port,
        secure: false,
        requireTLS: true,
        tls: { ca: serverCertificate.certPem, servername: "archive.example.com" },
      })
      .sendMail({
        from: "journal@tenant.onmicrosoft.com",
        to: "journal+known@archive.example.com",
        subject: "verified",
        text: "hello",
      });
    expect(received).toHaveLength(1);
  });

  it("does not deliver to a client that does not trust the certificate", async () => {
    const port = await start(acceptAll);
    await expect(
      nodemailer
        .createTransport({
          host: "127.0.0.1",
          port,
          secure: false,
          requireTLS: true,
          tls: { servername: "archive.example.com" },
        })
        .sendMail({
          from: "journal@tenant.onmicrosoft.com",
          to: "journal+known@archive.example.com",
          subject: "untrusted",
          text: "hello",
        }),
    ).rejects.toThrow();
  });

  it("does not take a delivery from a client that never issues STARTTLS", async () => {
    let receiveCalled = false;
    const port = await start({
      resolveTenant: async () => fakeRecord.tenantId,
      receive: async () => {
        receiveCalled = true;
        return fakeRecord;
      },
    });
    await expect(
      nodemailer
        .createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true })
        .sendMail({
          from: "journal@tenant.onmicrosoft.com",
          to: "journal+known@archive.example.com",
          subject: "plain",
          text: "hello",
        }),
    ).rejects.toThrow(/530/);
    expect(receiveCalled).toBe(false);
  });

  it("refuses to be built with an empty certificate instead of falling back to a built-in one", () => {
    expect(() =>
      createJournalServer({
        config,
        tls: { mode: "tls", key: Buffer.alloc(0), cert: Buffer.alloc(0) },
        providerDb: fakeProviderDb,
        receiverDeps: fakeReceiverDeps,
      }),
    ).toThrow(/non-empty TLS certificate and key/);
  });
});

describe("journal SMTP receiver, the explicit insecure opt-out", () => {
  it("does not offer STARTTLS and answers the command as unknown", async () => {
    const port = await start({ ...acceptAll, tls: { mode: "insecure" } });
    const session = await rawSmtp(port);
    const ehlo = await session.send("EHLO exchange.example.test");
    expect(ehlo.text).not.toContain("STARTTLS");
    expect((await session.send("STARTTLS")).code).toBe(500);
    session.close();
  });

  it("accepts mail in plain text", async () => {
    const received: number[] = [];
    const port = await start({
      tls: { mode: "insecure" },
      resolveTenant: async () => fakeRecord.tenantId,
      receive: async (_tenantId, raw) => {
        received.push(raw.length);
        return fakeRecord;
      },
    });
    await nodemailer
      .createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true })
      .sendMail({
        from: "journal@tenant.onmicrosoft.com",
        to: "journal+known@archive.example.com",
        subject: "plain",
        text: "hello",
      });
    expect(received).toHaveLength(1);
  });
});

describe("archive SMTP receiver, recipients and limits (0.4.4)", () => {
  const OTHER_TENANT = "33333333-3333-3333-3333-333333333333";
  const ACCOUNT = "44444444-4444-4444-4444-444444444444";
  const recipients = async (_db: Database, address: string): Promise<ArchiveRecipient | null> => {
    switch (address) {
      case "journal+known@archive.example.com":
        return { kind: "tenant", tenantId: fakeRecord.tenantId };
      case "archive+alice@archive.example.com":
        return { kind: "account", tenantId: fakeRecord.tenantId, protectedObjectId: ACCOUNT };
      case "journal+other@archive.example.com":
        return { kind: "tenant", tenantId: OTHER_TENANT };
      default:
        return null;
    }
  };

  async function deliver(
    port: number,
    from: string,
    to: readonly string[],
  ): Promise<{ codes: number[]; data: number | null }> {
    const session = await rawSmtp(port);
    await session.send("EHLO mx.hoster.example");
    const codes = [(await session.send(`MAIL FROM:<${from}>`)).code];
    for (const address of to) {
      codes.push((await session.send(`RCPT TO:<${address}>`)).code);
    }
    let data: number | null = null;
    if (codes.slice(1).includes(250)) {
      await session.send("DATA");
      data = (await session.send("Subject: copy\r\nMessage-ID: <c@x>\r\n\r\nhello\r\n.")).code;
    }
    session.close();
    return { codes, data };
  }

  it("takes an account address and the tenant's together and hands over the SMTP envelope", async () => {
    const deliveries: ArchiveDelivery[] = [];
    const port = await start({
      tls: { mode: "insecure" },
      resolveRecipient: recipients,
      receive: async (_tenantId, _raw, delivery) => {
        deliveries.push(delivery);
        return { kind: "forwarded_copy", outcome: "stored", itemId: fakeRecord.id, flags: [] };
      },
    });
    const result = await deliver(port, "SRS0=ab=cd=example.org=bob@hoster.example", [
      "archive+alice@archive.example.com",
      "journal+known@archive.example.com",
    ]);
    expect(result).toEqual({ codes: [250, 250, 250], data: 250 });
    expect(deliveries).toEqual([
      {
        tenantId: fakeRecord.tenantId,
        recipients: [
          { kind: "account", tenantId: fakeRecord.tenantId, protectedObjectId: ACCOUNT },
          { kind: "tenant", tenantId: fakeRecord.tenantId },
        ],
        mailFrom: "SRS0=ab=cd=example.org=bob@hoster.example",
        rcptTo: ["archive+alice@archive.example.com", "journal+known@archive.example.com"],
      },
    ]);
  });

  it("answers 452 for a recipient of a second tenant and delivers for the first only", async () => {
    const deliveries: ArchiveDelivery[] = [];
    const port = await start({
      tls: { mode: "insecure" },
      resolveRecipient: recipients,
      receive: async (_tenantId, _raw, delivery) => {
        deliveries.push(delivery);
        return fakeRecord;
      },
    });
    const result = await deliver(port, "bob@example.org", [
      "journal+known@archive.example.com",
      "journal+other@archive.example.com",
    ]);
    expect(result).toEqual({ codes: [250, 250, 452], data: 250 });
    expect(deliveries.map((delivery) => delivery.tenantId)).toEqual([fakeRecord.tenantId]);
    expect(deliveries[0]?.rcptTo).toEqual(["journal+known@archive.example.com"]);
  });

  it("starts every transaction afresh: the second tenant in its own transaction is accepted", async () => {
    const tenants: string[] = [];
    const port = await start({
      tls: { mode: "insecure" },
      resolveRecipient: recipients,
      receive: async (tenantId) => {
        tenants.push(tenantId);
        return fakeRecord;
      },
    });
    const session = await rawSmtp(port);
    await session.send("EHLO mx.hoster.example");
    for (const address of [
      "journal+known@archive.example.com",
      "journal+other@archive.example.com",
    ]) {
      expect((await session.send("MAIL FROM:<bob@example.org>")).code).toBe(250);
      expect((await session.send(`RCPT TO:<${address}>`)).code).toBe(250);
      await session.send("DATA");
      expect((await session.send("Subject: x\r\n\r\nx\r\n.")).code).toBe(250);
    }
    session.close();
    expect(tenants).toEqual([fakeRecord.tenantId, OTHER_TENANT]);
  });

  it("answers 451 at RCPT TO when an address is over its per-minute limit", async () => {
    const port = await start({
      tls: { mode: "insecure" },
      resolveRecipient: recipients,
      addressRateLimiter: createInMemoryRateLimiter(1),
      receive: async () => fakeRecord,
    });
    expect(
      await deliver(port, "bob@example.org", ["archive+alice@archive.example.com"]),
    ).toMatchObject({ codes: [250, 250], data: 250 });
    expect(await deliver(port, "bob@example.org", ["archive+alice@archive.example.com"])).toEqual({
      codes: [250, 451],
      data: null,
    });
    // Another address is not limited by it.
    expect(
      await deliver(port, "bob@example.org", ["journal+known@archive.example.com"]),
    ).toMatchObject({ codes: [250, 250], data: 250 });
  });

  it("forgets quiet keys of the limiter", () => {
    let now = 0;
    const limiter = createInMemoryRateLimiter(1, 1_000, () => now);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    now = 5_000;
    expect(limiter.allow("a")).toBe(true);
  });
});
