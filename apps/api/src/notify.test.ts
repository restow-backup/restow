import { configureProductName, supportedLanguages } from "@restow/i18n";
import { describe, expect, it } from "vitest";
import type { Config, SmtpConfig } from "./config.js";
import {
  GoogleNotifier,
  GraphNotifier,
  NoopNotifier,
  SMTP_TIMEOUTS,
  SmtpNotifier,
  createNotifier,
  notifierForTransport,
  smtpFailureReason,
  smtpTransportOptions,
  testNotification,
} from "./notify.js";

const base: SmtpConfig = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  username: "restow",
  password: "fixture-password",
  from: "restow@example.com",
};

/** A minimal, complete Config; tests override only the fields they care about. */
function fixtureConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: "test",
    port: 3000,
    publicUrl: "https://restow.example.com",
    apiUrl: undefined,
    trustedProxies: ["127.0.0.1/32", "::1/128"],
    productName: "Restow",
    operatingMode: "public",
    databaseUrl: "postgres://restow:unused@127.0.0.1:1/restow",
    databaseProviderUrl: "postgres://restow:unused@127.0.0.1:1/restow",
    betterAuthSecret: "fixture-secret",
    setupToken: undefined,
    masterKey: undefined,
    entra: {
      clientId: undefined,
      clientSecret: undefined,
      clientCertPath: undefined,
      authorityHost: undefined,
      ssoClientId: undefined,
      ssoClientSecret: undefined,
      ssoExperimental: false,
    },
    graphMailTenantId: undefined,
    mailTransport: undefined,
    smtp: base,
    graphMailSender: undefined,
    imapAllowPrivateNetworks: false,
    docsTroubleshootingUrl: "https://docs.example.test/troubleshooting/",
    demo: {
      enabled: false,
      email: undefined,
      password: undefined,
      seedToken: undefined,
    },
    journal: {
      port: undefined,
      hostname: undefined,
      tlsCertPath: undefined,
      tlsKeyPath: undefined,
      allowInsecure: false,
      maxSizeBytes: 150 * 1024 * 1024,
    },
    imports: {
      dir: "/var/lib/restow/import",
      maxFileBytes: 10 * 1024 * 1024 * 1024,
      uploadTtlHours: 48,
      maxStagingBytes: 100 * 1024 * 1024 * 1024,
      segmentBytes: 8 * 1024 * 1024,
      maxMessageBytes: 256 * 1024 * 1024,
    },
    exports: { ttlHours: 24, maxTenantBytes: 50 * 1024 * 1024 * 1024 },
    preview: { workers: 2, timeoutMs: 10_000 },
    ...overrides,
  };
}

describe("smtpTransportOptions", () => {
  it("requires the STARTTLS upgrade when the operator chose starttls", () => {
    const options = smtpTransportOptions({ ...base, security: "starttls" });
    expect(options).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
  });

  it("speaks TLS from the first byte for implicit TLS", () => {
    const options = smtpTransportOptions({
      ...base,
      port: 465,
      secure: true,
      security: "implicit",
    });
    expect(options).toMatchObject({ secure: true, requireTLS: false, ignoreTLS: false });
  });

  it("never upgrades when the operator chose no encryption", () => {
    const options = smtpTransportOptions({ ...base, port: 25, security: "none" });
    expect(options).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true });
  });

  it("follows the explicit choice over the port", () => {
    expect(smtpTransportOptions({ ...base, port: 465, security: "starttls" })).toMatchObject({
      secure: false,
      requireTLS: true,
    });
  });

  it("keeps opportunistic STARTTLS for environment configuration without a choice", () => {
    expect(smtpTransportOptions(base)).toMatchObject({
      secure: false,
      requireTLS: false,
      ignoreTLS: false,
    });
    expect(smtpTransportOptions({ ...base, port: 465 }).secure).toBe(true);
  });

  it("authenticates only with a username and always bounds the waits", () => {
    expect(smtpTransportOptions(base).auth).toEqual({ user: "restow", pass: "fixture-password" });
    const anonymous = smtpTransportOptions({ ...base, username: undefined, password: undefined });
    expect(anonymous.auth).toBeUndefined();
    expect(anonymous).toMatchObject(SMTP_TIMEOUTS);
  });
});

describe("testNotification", () => {
  it("is written in the requested language", () => {
    const german = testNotification("de");
    const english = testNotification("en");
    expect(german.subject).toBe("Restow: Testbenachrichtigung");
    expect(english.subject).toBe("Restow: notification test");
    expect(german.text).toContain("Mailversand");
    expect(english.text).toContain("mail delivery");
  });

  it("names the product the installation is branded with", () => {
    configureProductName("Acme Backup");
    try {
      expect(testNotification("en").subject).toBe("Acme Backup: notification test");
      expect(testNotification("de").text).toContain("Testbenachrichtigung von Acme Backup");
    } finally {
      configureProductName(null);
    }
  });

  it("resolves every text from the notifications namespace, with the app name filled in", () => {
    for (const language of supportedLanguages) {
      const { subject, text } = testNotification(language);
      for (const value of [subject, text]) {
        expect(value).not.toMatch(/notifications:|test\.(subject|body)|\{appName\}/);
        expect(value).toContain("Restow");
      }
    }
  });
});

describe("createNotifier", () => {
  it("picks SMTP by default and Graph when configured", () => {
    expect(createNotifier(fixtureConfig())).toBeInstanceOf(SmtpNotifier);
    expect(createNotifier(fixtureConfig({ mailTransport: "graph" }))).toBeInstanceOf(GraphNotifier);
  });

  it("is always a no-op in demo mode, whatever transport is configured", () => {
    const demo = {
      enabled: true,
      email: "demo@example.org",
      password: "x",
      seedToken: undefined,
    };
    expect(createNotifier(fixtureConfig({ demo }))).toBeInstanceOf(NoopNotifier);
    expect(createNotifier(fixtureConfig({ demo, mailTransport: "graph" }))).toBeInstanceOf(
      NoopNotifier,
    );
  });
});

describe("NoopNotifier", () => {
  it("never sends anything and always reports success", async () => {
    const notifier = new NoopNotifier();
    await expect(
      notifier.send({ to: "someone@example.org", subject: "s", text: "t" }),
    ).resolves.toEqual({ ok: true });
    await expect(notifier.sendTest("someone@example.org", "en")).resolves.toEqual({ ok: true });
  });
});

describe("smtpFailureReason", () => {
  const withCode = (code: string, message: string) => Object.assign(new Error(message), { code });

  it("tells a rejected login, a TLS problem and an unreachable server apart", () => {
    expect(smtpFailureReason(withCode("EAUTH", "Invalid login: 535 5.7.8"))).toBe(
      "smtp_auth_failed",
    );
    expect(smtpFailureReason(withCode("ESOCKET", "self-signed certificate in chain"))).toBe(
      "smtp_tls_failed",
    );
    expect(smtpFailureReason(withCode("ETLS", "Error initiating TLS"))).toBe("smtp_tls_failed");
    expect(smtpFailureReason(withCode("ESOCKET", "connect ECONNREFUSED 10.0.0.1:587"))).toBe(
      "smtp_connection_failed",
    );
    expect(smtpFailureReason(withCode("ETIMEDOUT", "Connection timeout"))).toBe(
      "smtp_connection_failed",
    );
    expect(smtpFailureReason(withCode("EENVELOPE", "No recipients defined"))).toBe(
      "transport_error",
    );
    expect(smtpFailureReason("odd")).toBe("transport_error");
  });
});

describe("notifierForTransport", () => {
  const google = { transport: "google" as const, sender: "a@example.com", key: null };
  const graph = { transport: "graph" as const, sender: "a@contoso.com", tenantId: null, app: null };
  const smtp = { transport: "smtp" as const, smtp: base };

  it("builds the transport's notifier", () => {
    expect(notifierForTransport(google, { demo: false })).toBeInstanceOf(GoogleNotifier);
    expect(notifierForTransport(graph, { demo: false })).toBeInstanceOf(GraphNotifier);
    expect(notifierForTransport(smtp, { demo: false })).toBeInstanceOf(SmtpNotifier);
  });

  it("sends nothing in demo mode, whatever the transport", () => {
    for (const spec of [google, graph, smtp]) {
      expect(notifierForTransport(spec, { demo: true })).toBeInstanceOf(NoopNotifier);
    }
  });
});
