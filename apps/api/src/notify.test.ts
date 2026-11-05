import { configureProductName, supportedLanguages } from "@restow/i18n";
import { describe, expect, it } from "vitest";
import type { Config, SmtpConfig } from "./config.js";
import {
  createNotifier,
  GoogleNotifier,
  GraphNotifier,
  isPermanentSmtpRejection,
  isSmtpSenderRejection,
  isTransportFailureReason,
  NoopNotifier,
  nodemailerAttachments,
  notifierForTransport,
  SMTP_TIMEOUTS,
  SmtpNotifier,
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
    dbPool: { app: 10, installation: 10, queue: 10 },
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
      ratePerIp: 600,
      ratePerAddress: 300,
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
    pve: { blockMapCacheBytes: 256 * 1024 * 1024 },
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

describe("permanent SMTP rejections (0.5.0)", () => {
  const smtpError = (responseCode: number, command: string, code = "EENVELOPE") =>
    Object.assign(new Error(`${responseCode} rejected`), { responseCode, command, code });

  it("treats 550, 551, 553 and 554 at RCPT or DATA as final", () => {
    expect(isPermanentSmtpRejection(smtpError(550, "RCPT TO"))).toBe(true);
    expect(isPermanentSmtpRejection(smtpError(554, "DATA", "EMESSAGE"))).toBe(true);
    expect(isPermanentSmtpRejection(smtpError(553, "RCPT TO", "EENVELOPE"))).toBe(true);
    // A temporary answer, or one to the login, is retried as before.
    expect(isPermanentSmtpRejection(smtpError(451, "RCPT TO"))).toBe(false);
    expect(isPermanentSmtpRejection(smtpError(535, "AUTH PLAIN", "EAUTH"))).toBe(false);
    expect(isPermanentSmtpRejection(new Error("boom"))).toBe(false);
    // nodemailer reports a refused MAIL FROM as EENVELOPE too: that is the sender, not the
    // recipient.
    expect(isPermanentSmtpRejection(smtpError(553, "MAIL FROM"))).toBe(false);
    expect(isSmtpSenderRejection(smtpError(553, "MAIL FROM"))).toBe(true);
    expect(isSmtpSenderRejection(smtpError(550, "RCPT TO"))).toBe(false);
    expect(isSmtpSenderRejection(smtpError(451, "MAIL FROM"))).toBe(false);
  });

  it("answers a refused sender as smtp_sender_rejected, a failure of the transport", async () => {
    const notifier = new SmtpNotifier({
      host: "smtp.example.com",
      port: 25,
      secure: false,
      from: "Alerts <alerts@example.com>",
    } as SmtpConfig);
    const transporter = (notifier as unknown as { transporter: { sendMail: unknown } }).transporter;
    transporter.sendMail = async () => {
      throw Object.assign(new Error("Mail command failed: 553 5.7.1 Sender address rejected"), {
        code: "EENVELOPE",
        responseCode: 553,
        command: "MAIL FROM",
      });
    };
    const result = await notifier.send({
      to: "ops@example.com",
      subject: "s",
      text: "t",
      from: { name: "MSP", address: "alerts@msp.example" },
    });
    expect(result).toMatchObject({ ok: false, reason: "smtp_sender_rejected" });
    expect(result.permanent).toBeUndefined();
    expect(isTransportFailureReason(result.reason)).toBe(true);
  });

  it("tells a sender refused at RCPT TO or DATA from a refused recipient", () => {
    const refusal = (responseCode: number, command: string, response: string, code = "EENVELOPE") =>
      Object.assign(new Error(`Command failed: ${response}`), {
        responseCode,
        command,
        code,
        response,
      });
    // Postfix with reject_sender_login_mismatch answers at RCPT TO (smtpd_delay_reject).
    const postfix = refusal(
      553,
      "RCPT TO",
      "553 5.7.1 <alerts@brand.example>: Sender address rejected: not owned by user msp-relay",
    );
    // Exchange Online refuses a From the mailbox may not send as after DATA.
    const exchange = refusal(
      554,
      "DATA",
      "554 5.2.252 SendAsDenied; relay@msp.example not allowed to send as alerts@brand.example; STOREDRV.Submission.Exception:SendAsDeniedException",
      "EMESSAGE",
    );
    for (const err of [postfix, exchange]) {
      expect(isSmtpSenderRejection(err)).toBe(true);
      expect(isPermanentSmtpRejection(err)).toBe(false);
    }
    // The wording in the reply alone is enough, the message may differ.
    expect(
      isSmtpSenderRejection(
        Object.assign(new Error("Message failed"), {
          responseCode: 550,
          command: "DATA",
          response: "550 5.7.60 SMTP; Client does not have permissions to send as this sender",
        }),
      ),
    ).toBe(true);
    // A refused recipient stays the recipient's, a temporary answer stays retried.
    const unknown = refusal(
      550,
      "RCPT TO",
      "550 5.1.1 <gone@example.com>: Recipient address rejected",
    );
    expect(isSmtpSenderRejection(unknown)).toBe(false);
    expect(isPermanentSmtpRejection(unknown)).toBe(true);
    expect(
      isSmtpSenderRejection(
        refusal(451, "RCPT TO", "451 4.7.1 Sender address rejected: try later"),
      ),
    ).toBe(false);
  });

  it("answers a branded From the server refuses at RCPT TO as smtp_sender_rejected", async () => {
    const notifier = new SmtpNotifier({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      from: "Alerts <alerts@example.com>",
    } as SmtpConfig);
    const transporter = (notifier as unknown as { transporter: { sendMail: unknown } }).transporter;
    transporter.sendMail = async () => {
      const response =
        "553 5.7.1 <alerts@msp.example>: Sender address rejected: not owned by user relay";
      throw Object.assign(new Error(`Recipient command failed: ${response}`), {
        code: "EENVELOPE",
        responseCode: 553,
        command: "RCPT TO",
        response,
      });
    };
    const result = await notifier.send({
      to: "ops@example.com",
      subject: "s",
      text: "t",
      from: { name: "MSP", address: "alerts@msp.example" },
    });
    expect(result).toMatchObject({ ok: false, reason: "smtp_sender_rejected" });
    expect(result.permanent).toBeUndefined();
    expect(isTransportFailureReason(result.reason)).toBe(true);
  });

  it("answers a refused recipient as recipient_rejected, permanent", async () => {
    const notifier = new SmtpNotifier({
      host: "smtp.example.com",
      port: 25,
      secure: false,
      from: "Alerts <alerts@example.com>",
    } as SmtpConfig);
    const transporter = (notifier as unknown as { transporter: { sendMail: unknown } }).transporter;
    const sent: Record<string, unknown>[] = [];
    transporter.sendMail = async (options: Record<string, unknown>) => {
      sent.push(options);
      throw smtpError(550, "RCPT TO");
    };
    const result = await notifier.send({
      to: "gone@example.com",
      subject: "s",
      text: "t",
      from: { name: "MSP\r\nBcc: x@example.com", address: null },
      replyTo: "help@msp.example",
    });
    expect(result).toMatchObject({ ok: false, reason: "recipient_rejected", permanent: true });
    // The branded name, the configured address; Reply-To as given.
    expect(sent[0]?.from).toEqual({
      name: "MSP Bcc: x@example.com",
      address: "alerts@example.com",
    });
    expect(sent[0]?.replyTo).toBe("help@msp.example");
  });

  it("makes an attachment with a Content-ID inline", () => {
    expect(
      nodemailerAttachments({
        to: "a@example.com",
        subject: "s",
        text: "t",
        attachments: [
          { filename: "logo.png", contentType: "image/png", content: Buffer.from("x"), cid: "c@x" },
          { filename: "r.pdf", contentType: "application/pdf", content: Buffer.from("y") },
        ],
      }),
    ).toEqual([
      {
        filename: "logo.png",
        contentType: "image/png",
        content: Buffer.from("x"),
        cid: "c@x",
        contentDisposition: "inline",
      },
      { filename: "r.pdf", contentType: "application/pdf", content: Buffer.from("y") },
    ]);
  });

  it("tells transport-wide reasons from a recipient's", () => {
    expect(isTransportFailureReason("smtp_auth_failed")).toBe(true);
    expect(isTransportFailureReason("smtp_sender_rejected")).toBe(true);
    expect(isTransportFailureReason("mail_not_configured")).toBe(true);
    expect(isTransportFailureReason("graph_token_failed")).toBe(true);
    expect(isTransportFailureReason("google_send_denied")).toBe(true);
    expect(isTransportFailureReason("recipient_rejected")).toBe(false);
    expect(isTransportFailureReason("transport_error")).toBe(false);
  });
});

describe("notifierForTransport", () => {
  const google = { transport: "google" as const, sender: "a@example.com", key: null };
  const graph = {
    transport: "graph" as const,
    sender: "a@contoso.com",
    tenantId: null,
    app: null,
    appKind: "own" as const,
  };
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
