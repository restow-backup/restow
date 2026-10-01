import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CertificateDir,
  HOUR_MS,
  type SelfSignedCertificate,
  certificate,
  certificateDir,
} from "./tls-test-support.js";
import {
  type JournalTlsMaterial,
  type JournalTlsPlanInput,
  type JournalTlsStatus,
  loadJournalTls,
  planJournalTls,
  watchJournalCertificate,
} from "./tls.js";

/**
 * The receiver's TLS decisions (docs/ARCHIVE.md, journal setup section): the
 * start decision matrix, what makes a certificate unusable,
 * and how a renewed certificate is picked up. The certificates are throwaway
 * ones generated here, with validity windows chosen per case.
 */

const cleanups: CertificateDir[] = [];

function files(pair?: SelfSignedCertificate): CertificateDir {
  const dir = certificateDir(pair);
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    dir.remove();
  }
});

const now = new Date();

function plan(input: Partial<JournalTlsPlanInput> = {}) {
  return planJournalTls({
    tlsCertPath: undefined,
    tlsKeyPath: undefined,
    allowInsecure: false,
    now,
    ...input,
  });
}

describe("planJournalTls, the start decision", () => {
  it("does not start without a certificate, in production and in development alike", () => {
    // The decision has no environment input on purpose: NODE_ENV only changes what is logged.
    expect(plan()).toMatchObject({ start: false, reason: "tls_not_configured" });
  });

  it("does not start with only one of the two files configured, even with the opt-out", () => {
    const dir = files(certificate());
    for (const allowInsecure of [false, true]) {
      expect(plan({ tlsCertPath: dir.certPath, allowInsecure })).toMatchObject({
        start: false,
        reason: "tls_invalid",
      });
      expect(plan({ tlsKeyPath: dir.keyPath, allowInsecure })).toMatchObject({
        start: false,
        reason: "tls_invalid",
      });
    }
  });

  it("starts without STARTTLS only with the explicit opt-out and no certificate", () => {
    expect(plan({ allowInsecure: true })).toEqual({ start: true, mode: "insecure" });
  });

  it("starts with TLS when certificate and key are valid", () => {
    const pair = certificate({ notAfter: new Date(now.getTime() + 24 * HOUR_MS) });
    const dir = files(pair);
    const result = plan({ tlsCertPath: dir.certPath, tlsKeyPath: dir.keyPath });
    expect(result).toMatchObject({ start: true, mode: "tls" });
    if (result.start && result.mode === "tls") {
      expect(result.material.cert.toString()).toBe(pair.certPem);
      expect(result.material.key.toString()).toBe(pair.keyPem);
      expect(result.material.subject).toBe("CN=archive.example.com");
      expect(result.material.notAfter.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("serves a configured certificate even when the opt-out is set too", () => {
    const dir = files(certificate());
    expect(
      plan({ tlsCertPath: dir.certPath, tlsKeyPath: dir.keyPath, allowInsecure: true }),
    ).toMatchObject({ start: true, mode: "tls" });
  });

  it("does not start with an expired certificate, whatever the opt-out says", () => {
    const dir = files(
      certificate({
        notBefore: new Date(now.getTime() - 48 * HOUR_MS),
        notAfter: new Date(now.getTime() - HOUR_MS),
      }),
    );
    for (const allowInsecure of [false, true]) {
      const result = plan({ tlsCertPath: dir.certPath, tlsKeyPath: dir.keyPath, allowInsecure });
      expect(result).toMatchObject({ start: false, reason: "tls_expired" });
      expect(result.start === false && result.message).toContain("expired on");
    }
  });

  it("does not start when the configured files cannot be read, whatever the opt-out says", () => {
    const dir = files();
    for (const allowInsecure of [false, true]) {
      expect(
        plan({ tlsCertPath: dir.certPath, tlsKeyPath: dir.keyPath, allowInsecure }),
      ).toMatchObject({ start: false, reason: "tls_invalid" });
    }
  });

  it("treats the validity boundary as expired: a certificate is good until its last second", () => {
    const notAfter = new Date(now.getTime() + 60_000);
    const dir = files(certificate({ notAfter }));
    const input = { tlsCertPath: dir.certPath, tlsKeyPath: dir.keyPath };
    expect(plan({ ...input, now: new Date(notAfter.getTime() - 5_000) })).toMatchObject({
      start: true,
    });
    expect(plan({ ...input, now: new Date(notAfter.getTime() + 5_000) })).toMatchObject({
      start: false,
      reason: "tls_expired",
    });
  });
});

describe("loadJournalTls", () => {
  function load(
    setup: (dir: CertificateDir) => void,
    read?: (path: string) => Buffer,
  ): ReturnType<typeof loadJournalTls> {
    const dir = files();
    setup(dir);
    return loadJournalTls({ certPath: dir.certPath, keyPath: dir.keyPath }, now, read);
  }

  it("names the file that cannot be read, without anything from inside it", () => {
    const missing = load(() => undefined);
    expect(missing).toMatchObject({ ok: false, reason: "tls_invalid" });
    expect(missing.ok === false && missing.message).toMatch(
      /the certificate file .*fullchain\.pem cannot be read \(ENOENT\)/u,
    );

    const pair = certificate();
    const denied = load(
      () => undefined,
      (path) => {
        if (path.endsWith("privkey.pem")) {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return Buffer.from(pair.certPem);
      },
    );
    expect(denied.ok === false && denied.message).toMatch(
      /the private key file .*privkey\.pem cannot be read \(EACCES\)/u,
    );
  });

  it("refuses files that are not PEM", () => {
    const pair = certificate();
    const notCertificate = load((dir) => {
      dir.write({ certPem: "this is not a certificate\n", keyPem: pair.keyPem });
    });
    expect(notCertificate.ok === false && notCertificate.message).toContain(
      "holds no PEM certificate",
    );

    const notKey = load((dir) => {
      dir.write({ certPem: pair.certPem, keyPem: "this is not a key\n" });
    });
    expect(notKey.ok === false && notKey.message).toContain("holds no unencrypted PEM private key");

    const der = load(
      () => undefined,
      (path) =>
        path.endsWith("fullchain.pem")
          ? Buffer.from([0x30, 0x82, 0x01, 0x0a])
          : Buffer.from(pair.keyPem),
    );
    expect(der).toMatchObject({ ok: false, reason: "tls_invalid" });
    expect(der.ok === false && der.message).toContain("holds no PEM certificate");
  });

  it("refuses an encrypted private key, which would need a passphrase nobody can give", () => {
    const pair = certificate();
    const encrypted = load((dir) => {
      dir.write({
        certPem: pair.certPem,
        keyPem:
          "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIBsomething\n-----END ENCRYPTED PRIVATE KEY-----\n",
      });
    });
    expect(encrypted.ok === false && encrypted.message).toContain("encrypted key cannot be used");
  });

  it("refuses markers with garbage inside, and a key that does not belong to the certificate", () => {
    const pair = certificate();
    const other = certificate();
    const garbage = load((dir) => {
      dir.write({
        certPem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
        keyPem: pair.keyPem,
      });
    });
    expect(garbage.ok === false && garbage.message).toContain("is not a valid certificate");

    const brokenKey = load((dir) => {
      dir.write({
        certPem: pair.certPem,
        keyPem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
      });
    });
    expect(brokenKey.ok === false && brokenKey.message).toContain("is not a valid private key");

    const mismatch = load((dir) => {
      dir.write({ certPem: pair.certPem, keyPem: other.keyPem });
    });
    expect(mismatch.ok === false && mismatch.message).toContain(
      "does not belong to the certificate",
    );
  });

  it("refuses a certificate that is not valid yet, and one that has expired", () => {
    const future = load((dir) => {
      dir.write(
        certificate({
          notBefore: new Date(now.getTime() + HOUR_MS),
          notAfter: new Date(now.getTime() + 48 * HOUR_MS),
        }),
      );
    });
    expect(future).toMatchObject({ ok: false, reason: "tls_invalid" });
    expect(future.ok === false && future.message).toContain("is not valid before");

    const expired = load((dir) => {
      dir.write(
        certificate({
          notBefore: new Date(now.getTime() - 48 * HOUR_MS),
          notAfter: new Date(now.getTime() - HOUR_MS),
        }),
      );
    });
    expect(expired).toMatchObject({ ok: false, reason: "tls_expired" });
  });

  it("never puts key material into a message", () => {
    const pair = certificate();
    const other = certificate();
    const secretBody = pair.keyPem.split("\n")[1] ?? "";
    const results = [
      load((dir) => dir.write({ certPem: pair.certPem, keyPem: other.keyPem })),
      load((dir) => dir.write({ certPem: pair.certPem, keyPem: `${pair.keyPem.slice(0, 40)}` })),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).not.toContain(secretBody);
    }
  });
});

describe("watchJournalCertificate", () => {
  function memory(initial: SelfSignedCertificate) {
    const store = new Map<string, Buffer>();
    const set = (pair: { certPem: string; keyPem: string }) => {
      store.set("/tls/fullchain.pem", Buffer.from(pair.certPem));
      store.set("/tls/privkey.pem", Buffer.from(pair.keyPem));
    };
    set(initial);
    return {
      set,
      setCertificateOnly: (certPem: string) =>
        store.set("/tls/fullchain.pem", Buffer.from(certPem)),
      remove: () => store.clear(),
      read: (path: string) => {
        const bytes = store.get(path);
        if (!bytes) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return bytes;
      },
    };
  }

  function start(initial: SelfSignedCertificate, clock: { at: number }) {
    const disk = memory(initial);
    const loaded = loadJournalTls(
      { certPath: "/tls/fullchain.pem", keyPath: "/tls/privkey.pem" },
      new Date(clock.at),
      disk.read,
    );
    if (!loaded.ok) {
      throw new Error(loaded.message);
    }
    const applied: JournalTlsMaterial[] = [];
    const statuses: JournalTlsStatus[] = [];
    const logger = { info: vi.fn(), error: vi.fn() };
    const watcher = watchJournalCertificate({
      paths: { certPath: "/tls/fullchain.pem", keyPath: "/tls/privkey.pem" },
      initial: loaded.material,
      apply: (material) => applied.push(material),
      onStatus: (status) => statuses.push(status),
      intervalMs: 3_600_000,
      now: () => new Date(clock.at),
      read: disk.read,
      logger,
    });
    return { disk, applied, statuses, logger, watcher };
  }

  it("changes nothing while the files are the ones in use", () => {
    const clock = { at: Date.now() };
    const { watcher, applied, statuses, logger } = start(certificate(), clock);
    watcher.check();
    watcher.check();
    watcher.stop();
    expect(applied).toHaveLength(0);
    expect(statuses).toEqual([{ ok: true }, { ok: true }]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("hands a renewed certificate to the listener", () => {
    const clock = { at: Date.now() };
    const { watcher, disk, applied, logger } = start(certificate(), clock);
    const renewed = certificate({ notAfter: new Date(clock.at + 90 * 24 * HOUR_MS) });
    disk.set(renewed);
    watcher.check();
    watcher.check();
    watcher.stop();
    expect(applied).toHaveLength(1);
    expect(applied[0]?.cert.toString()).toBe(renewed.certPem);
    expect(applied[0]?.key.toString()).toBe(renewed.keyPem);
    expect(logger.info).toHaveBeenCalledWith(
      "journal TLS certificate reloaded",
      expect.objectContaining({ subject: "CN=archive.example.com" }),
    );
  });

  it("keeps the certificate in use while a renewal is half written or broken, and says so once", () => {
    const clock = { at: Date.now() };
    const { watcher, disk, applied, statuses, logger } = start(certificate(), clock);
    const renewed = certificate();
    // The renewal client has written the new certificate, not yet the new key.
    disk.setCertificateOnly(renewed.certPem);
    watcher.check();
    watcher.check();
    expect(applied).toHaveLength(0);
    expect(statuses.every((status) => status.ok)).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);
    // The key follows: the pair is taken over as a whole.
    disk.set(renewed);
    watcher.check();
    watcher.stop();
    expect(applied).toHaveLength(1);
  });

  it("keeps serving when the files disappear, while the certificate in use is valid", () => {
    const clock = { at: Date.now() };
    const { watcher, disk, applied, statuses } = start(certificate(), clock);
    disk.remove();
    watcher.check();
    watcher.stop();
    expect(applied).toHaveLength(0);
    expect(statuses).toEqual([{ ok: true }]);
  });

  it("reports the certificate in use as expired once it runs out, and recovers with a renewal", () => {
    const clock = { at: Date.now() };
    const { watcher, disk, applied, statuses } = start(
      certificate({
        notBefore: new Date(clock.at - HOUR_MS),
        notAfter: new Date(clock.at + 2 * HOUR_MS),
      }),
      clock,
    );
    clock.at += 3 * HOUR_MS;
    watcher.check();
    expect(statuses.at(-1)).toMatchObject({ ok: false, reason: "tls_expired" });
    const expiredStatus = statuses.at(-1);
    expect(expiredStatus && !expiredStatus.ok && expiredStatus.message).toContain(
      "no usable replacement",
    );

    disk.set(
      certificate({
        notBefore: new Date(clock.at - HOUR_MS),
        notAfter: new Date(clock.at + 90 * 24 * HOUR_MS),
      }),
    );
    watcher.check();
    watcher.stop();
    expect(applied).toHaveLength(1);
    expect(statuses.at(-1)).toEqual({ ok: true });
  });

  it("does not take over a replacement that has already expired", () => {
    const clock = { at: Date.now() };
    const { watcher, disk, applied, statuses } = start(certificate(), clock);
    disk.set(
      certificate({
        notBefore: new Date(clock.at - 48 * HOUR_MS),
        notAfter: new Date(clock.at - HOUR_MS),
      }),
    );
    watcher.check();
    watcher.stop();
    expect(applied).toHaveLength(0);
    expect(statuses).toEqual([{ ok: true }]);
  });

  it("keeps the certificate in use when the listener refuses the new one", () => {
    const clock = { at: Date.now() };
    const disk = memory(certificate());
    const loaded = loadJournalTls(
      { certPath: "/tls/fullchain.pem", keyPath: "/tls/privkey.pem" },
      new Date(clock.at),
      disk.read,
    );
    if (!loaded.ok) {
      throw new Error(loaded.message);
    }
    const statuses: JournalTlsStatus[] = [];
    const logger = { info: vi.fn(), error: vi.fn() };
    const watcher = watchJournalCertificate({
      paths: { certPath: "/tls/fullchain.pem", keyPath: "/tls/privkey.pem" },
      initial: loaded.material,
      apply: () => {
        throw new Error("secure context refused");
      },
      onStatus: (status) => statuses.push(status),
      intervalMs: 3_600_000,
      now: () => new Date(clock.at),
      read: disk.read,
      logger,
    });
    disk.set(certificate());
    watcher.check();
    watcher.stop();
    expect(statuses).toEqual([{ ok: true }]);
    expect(logger.error).toHaveBeenCalledWith(
      "journal TLS certificate could not be reloaded",
      expect.objectContaining({ errorMessage: expect.stringContaining("secure context refused") }),
    );
  });
});
