import type { AddressInfo } from "node:net";
import { archive } from "@restow/core";
import type { Database } from "@restow/db";
import nodemailer from "nodemailer";
import type { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../../../apps/api/src/config.js";
import type { JournalReceiverDeps } from "./receiver.js";
import {
  type JournalServerOptions,
  type JournalServerTls,
  createInMemoryRateLimiter,
  createJournalServer,
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
 * client, `resolveTenant` and `receive` faked so this never touches Postgres
 * or storage. The certificates are throwaway ones generated here.
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
  resolveTenant: (providerDb: Database, address: string) => Promise<string | null>;
  receive: (
    tenantId: string,
    raw: Buffer,
    deps: JournalReceiverDeps,
  ) => Promise<archive.ArchiveItemRecord>;
  tls?: JournalServerTls;
  logger?: JournalServerOptions["logger"];
}): Promise<number> {
  server = createJournalServer({
    config,
    tls: options.tls ?? tlsMode,
    providerDb: fakeProviderDb,
    receiverDeps: fakeReceiverDeps,
    rateLimiter: createInMemoryRateLimiter(1000),
    resolveTenant: options.resolveTenant,
    receive: options.receive,
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
        ...acceptAll,
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
