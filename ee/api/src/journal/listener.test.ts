import net from "node:net";
import type { archive } from "@restow/core";
import type { Database } from "@restow/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type JournalListenerOptions, startJournalListener } from "./listener.js";
import type { JournalReceiverState } from "./receiver-state.js";
import type { JournalReceiverDeps } from "./receiver.js";
import {
  type CertificateDir,
  HOUR_MS,
  type SelfSignedCertificate,
  certificate,
  certificateDir,
  fingerprint,
  rawSmtp,
} from "./tls-test-support.js";

/**
 * The receiver's start (./listener.ts), with the state the setup page shows for
 * every outcome: no listener (and a closed port) without a usable certificate,
 * the explicit insecure opt-out, a certificate that is served and required, and
 * a renewal or an expiry while the listener runs.
 */

const fakeRecord = { id: "11111111-1111-1111-1111-111111111111" } as archive.ArchiveItemRecord;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function files(pair?: SelfSignedCertificate): CertificateDir {
  const dir = certificateDir(pair);
  cleanups.push(() => dir.remove());
  return dir;
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

interface Harness {
  port: number;
  states: JournalReceiverState[];
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  handle: { close(): void } | null;
}

async function start(
  config: {
    tlsCertPath?: string;
    tlsKeyPath?: string;
    allowInsecure?: boolean;
  },
  extra: Partial<JournalListenerOptions> & { production?: boolean } = {},
): Promise<Harness> {
  const port = await freePort();
  const states: JournalReceiverState[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handle = await startJournalListener({
    config: {
      port,
      hostname: "archive.example.com",
      maxSizeBytes: 1024 * 1024,
      tlsCertPath: config.tlsCertPath,
      tlsKeyPath: config.tlsKeyPath,
      allowInsecure: config.allowInsecure ?? false,
    },
    production: true,
    server: {
      providerDb: {} as Database,
      receiverDeps: {} as JournalReceiverDeps,
      resolveTenant: async () => "22222222-2222-2222-2222-222222222222",
      receive: async () => fakeRecord,
    },
    setState: (state) => states.push(state),
    logger,
    ...extra,
  });
  if (handle) {
    cleanups.push(() => handle.close());
  }
  return { port, states, logger, handle };
}

describe("startJournalListener without a usable certificate", () => {
  it("does not open the port and records tls_not_configured, in production and in development", async () => {
    for (const production of [true, false]) {
      const harness = await start({}, { production });
      expect(harness.handle).toBeNull();
      expect(harness.states).toEqual([{ phase: "tls_not_configured" }]);
      expect(await portIsOpen(harness.port)).toBe(false);
      expect(harness.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("no TLS certificate is configured"),
        expect.anything(),
      );
    }
  });

  it("records tls_invalid with the file named in the log, and keeps the port closed", async () => {
    const dir = files();
    for (const allowInsecure of [false, true]) {
      const harness = await start({
        tlsCertPath: dir.certPath,
        tlsKeyPath: dir.keyPath,
        allowInsecure,
      });
      expect(harness.handle).toBeNull();
      expect(harness.states).toEqual([
        { phase: "tls_invalid", message: expect.stringContaining("fullchain.pem") },
      ]);
      expect(await portIsOpen(harness.port)).toBe(false);
    }
  });

  it("records tls_expired for an expired certificate and keeps the port closed", async () => {
    const dir = files(
      certificate({
        notBefore: new Date(Date.now() - 48 * HOUR_MS),
        notAfter: new Date(Date.now() - HOUR_MS),
      }),
    );
    const harness = await start({ tlsCertPath: dir.certPath, tlsKeyPath: dir.keyPath });
    expect(harness.handle).toBeNull();
    expect(harness.states).toEqual([
      { phase: "tls_expired", message: expect.stringContaining("expired on") },
    ]);
    expect(await portIsOpen(harness.port)).toBe(false);
  });
});

describe("startJournalListener with the explicit insecure opt-out", () => {
  it("listens without STARTTLS and warns, more sharply in production", async () => {
    const production = await start({ allowInsecure: true }, { production: true });
    expect(production.states).toEqual([{ phase: "listening", port: production.port }]);
    const session = await rawSmtp(production.port);
    expect((await session.send("EHLO test.example")).text).not.toContain("STARTTLS");
    session.close();
    expect(production.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("in a production environment"),
    );

    const development = await start({ allowInsecure: true }, { production: false });
    expect(development.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("For local development only"),
    );
    expect(development.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("in a production environment"),
    );
  });

  it("records stopped when it is closed", async () => {
    const harness = await start({ allowInsecure: true });
    harness.handle?.close();
    expect(harness.states.at(-1)).toEqual({ phase: "stopped" });
  });
});

describe("startJournalListener with a certificate", () => {
  it("listens, requires TLS and serves the configured certificate", async () => {
    const pair = certificate();
    const dir = files(pair);
    const harness = await start({ tlsCertPath: dir.certPath, tlsKeyPath: dir.keyPath });
    expect(harness.states).toEqual([{ phase: "listening", port: harness.port }]);

    const session = await rawSmtp(harness.port);
    await session.send("EHLO test.example");
    expect((await session.send("MAIL FROM:<a@b.example>")).code).toBe(530);
    expect((await session.send("STARTTLS")).code).toBe(220);
    expect(await session.upgrade()).toBe(fingerprint(pair.certPem));
    session.close();
    expect(harness.logger.warn).not.toHaveBeenCalled();
  });

  it("records failed when the port cannot be bound, and opens no watcher", async () => {
    const dir = files(certificate());
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    cleanups.push(() => blocker.close());
    const port = (blocker.address() as net.AddressInfo).port;
    const states: JournalReceiverState[] = [];
    const handle = await startJournalListener({
      config: {
        port,
        hostname: "archive.example.com",
        maxSizeBytes: 1024,
        tlsCertPath: dir.certPath,
        tlsKeyPath: dir.keyPath,
        allowInsecure: false,
      },
      production: true,
      server: { providerDb: {} as Database, receiverDeps: {} as JournalReceiverDeps },
      setState: (state) => states.push(state),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    handle?.close();
    expect(states[0]).toMatchObject({
      phase: "failed",
      message: expect.stringContaining("EADDRINUSE"),
    });
  });

  it("serves a renewed certificate to new sessions without a restart", async () => {
    const first = certificate();
    const dir = files(first);
    const harness = await start(
      { tlsCertPath: dir.certPath, tlsKeyPath: dir.keyPath },
      { certificateCheckIntervalMs: 25 },
    );
    async function presented(): Promise<string> {
      const session = await rawSmtp(harness.port);
      await session.send("EHLO test.example");
      await session.send("STARTTLS");
      const seen = await session.upgrade();
      session.close();
      return seen;
    }
    expect(await presented()).toBe(fingerprint(first.certPem));

    const renewed = certificate();
    dir.write(renewed);
    await vi.waitFor(async () => expect(await presented()).toBe(fingerprint(renewed.certPem)), {
      timeout: 5000,
      interval: 50,
    });
    expect(harness.states.every((state) => state.phase === "listening")).toBe(true);
    expect(harness.logger.info).toHaveBeenCalledWith(
      "journal TLS certificate reloaded",
      expect.objectContaining({ subject: "CN=archive.example.com" }),
    );
  });

  it("records tls_expired when the certificate runs out, and listening again after a renewal", async () => {
    const clock = { at: Date.now() };
    const dir = files(
      certificate({
        notBefore: new Date(clock.at - HOUR_MS),
        notAfter: new Date(clock.at + 2 * HOUR_MS),
      }),
    );
    const harness = await start(
      { tlsCertPath: dir.certPath, tlsKeyPath: dir.keyPath },
      { certificateCheckIntervalMs: 25, now: () => new Date(clock.at) },
    );
    expect(harness.states.at(-1)).toEqual({ phase: "listening", port: harness.port });

    clock.at += 3 * HOUR_MS;
    await vi.waitFor(() => expect(harness.states.at(-1)?.phase).toBe("tls_expired"), {
      timeout: 5000,
      interval: 25,
    });

    dir.write(
      certificate({
        notBefore: new Date(clock.at - HOUR_MS),
        notAfter: new Date(clock.at + 90 * 24 * HOUR_MS),
      }),
    );
    await vi.waitFor(() => expect(harness.states.at(-1)?.phase).toBe("listening"), {
      timeout: 5000,
      interval: 25,
    });
  });

  it("does not let a failing client handshake mark the receiver as failed", async () => {
    const dir = files(certificate());
    const harness = await start({ tlsCertPath: dir.certPath, tlsKeyPath: dir.keyPath });
    const errors: string[] = [];
    harness.logger.error.mockImplementation((message: string) => errors.push(message));
    const session = await rawSmtp(harness.port);
    await session.send("EHLO test.example");
    expect((await session.send("STARTTLS")).code).toBe(220);
    // Garbage instead of a TLS handshake: smtp-server reports it as a server error.
    session.write("this is not a TLS client hello\r\n");
    await vi.waitFor(() => expect(errors.join("\n")).toContain("server error"), {
      timeout: 5000,
      interval: 25,
    });
    session.close();
    expect(harness.states).toEqual([{ phase: "listening", port: harness.port }]);
  });
});
