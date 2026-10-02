import { describe, expect, it } from "vitest";
import { ProblemError } from "./problem.js";
import { isConfigured } from "./routes/setup.js";
import { parseOrProblem, setupRequestSchema, toStoredSmtpSecurity } from "./schemas.js";

const validSmtp = {
  operatingMode: "public",
  publicUrl: "https://restow.example.com",
  providerName: "Example IT Services",
  firstAdmin: { name: "Operator", email: "ops@example.com", password: "correct-horse-battery" },
  mail: {
    transport: "smtp",
    smtp: { host: "mail.example.com", port: 587, security: "starttls", from: "restow@example.com" },
  },
};

describe("setupRequestSchema", () => {
  it("accepts a complete SMTP setup and applies defaults", () => {
    const parsed = setupRequestSchema.parse(validSmtp);
    expect(parsed.sendTest).toBe(false);
    expect(parsed.mail?.transport).toBe("smtp");
  });

  it("accepts a Graph mail setup with an optional tenant id", () => {
    const parsed = setupRequestSchema.parse({
      ...validSmtp,
      mail: { transport: "graph", graph: { sender: "restow@example.com", tenantId: "contoso" } },
    });
    expect(parsed.mail?.transport === "graph" && parsed.mail.graph.tenantId).toBe("contoso");
  });

  it("requires the name of the operator's own organisation, trimmed and at most 200 characters", () => {
    const { providerName: _omitted, ...withoutName } = validSmtp;
    expect(setupRequestSchema.safeParse(withoutName).success).toBe(false);
    expect(setupRequestSchema.safeParse({ ...validSmtp, providerName: "   " }).success).toBe(false);
    expect(
      setupRequestSchema.safeParse({ ...validSmtp, providerName: "x".repeat(201) }).success,
    ).toBe(false);
    const parsed = setupRequestSchema.parse({ ...validSmtp, providerName: "  Müller IT GmbH  " });
    expect(parsed.providerName).toBe("Müller IT GmbH");
    expect(
      setupRequestSchema.safeParse({ ...validSmtp, providerName: "x".repeat(200) }).success,
    ).toBe(true);
  });

  it("requires a password of at least 12 characters", () => {
    const short = { ...validSmtp, firstAdmin: { ...validSmtp.firstAdmin, password: "short-pass" } };
    const result = setupRequestSchema.safeParse(short);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["firstAdmin", "password"]);
    }
    expect(
      setupRequestSchema.safeParse({
        ...validSmtp,
        firstAdmin: { ...validSmtp.firstAdmin, password: "twelve-chars" },
      }).success,
    ).toBe(true);
  });

  it("rejects an invalid admin email and an unknown transport", () => {
    expect(
      setupRequestSchema.safeParse({
        ...validSmtp,
        firstAdmin: { ...validSmtp.firstAdmin, email: "not-an-email" },
      }).success,
    ).toBe(false);
    expect(
      setupRequestSchema.safeParse({ ...validSmtp, mail: { transport: "sendmail" } }).success,
    ).toBe(false);
  });

  it("accepts the language the wizard chose, de or en, and nothing else", () => {
    expect(setupRequestSchema.parse({ ...validSmtp, language: "de" }).language).toBe("de");
    expect(setupRequestSchema.parse({ ...validSmtp, language: "en" }).language).toBe("en");
    // A client that sends none keeps the old behaviour: the tenant defers to the installation default.
    expect(setupRequestSchema.parse(validSmtp).language).toBeUndefined();
    for (const language of ["fr", "DE", "de-DE", "", null]) {
      expect(
        setupRequestSchema.safeParse({ ...validSmtp, language }).success,
        String(language),
      ).toBe(false);
    }
  });

  it("accepts a setup without a mail transport, the wizard's skipped mail step", () => {
    const { mail: _omitted, ...withoutMail } = validSmtp;
    const parsed = setupRequestSchema.parse(withoutMail);
    expect(parsed.mail).toBeUndefined();
    expect(parsed.sendTest).toBe(false);
  });

  it("refuses a test message without a mail transport to send it through", () => {
    const { mail: _omitted, ...withoutMail } = validSmtp;
    const result = setupRequestSchema.safeParse({ ...withoutMail, sendTest: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(["sendTest"]);
    }
    expect(setupRequestSchema.safeParse({ ...validSmtp, sendTest: true }).success).toBe(true);
  });

  it("still refuses a mail transport that is present but incomplete", () => {
    expect(
      setupRequestSchema.safeParse({ ...validSmtp, mail: { transport: "smtp" } }).success,
    ).toBe(false);
  });

  it("accepts both the contract's and the stored SMTP security names", () => {
    for (const security of ["starttls", "tls", "implicit", "none"]) {
      const result = setupRequestSchema.safeParse({
        ...validSmtp,
        mail: { ...validSmtp.mail, smtp: { ...validSmtp.mail.smtp, security } },
      });
      expect(result.success, security).toBe(true);
    }
    expect(toStoredSmtpSecurity("tls")).toBe("implicit");
    expect(toStoredSmtpSecurity("starttls")).toBe("starttls");
    expect(toStoredSmtpSecurity("none")).toBe("none");
  });
});

describe("parseOrProblem", () => {
  it("throws a 422 problem carrying the issues", () => {
    expect.assertions(3);
    try {
      parseOrProblem(setupRequestSchema, { operatingMode: "local" });
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemError);
      const problem = error as ProblemError;
      expect(problem.status).toBe(422);
      expect(Array.isArray(problem.extensions?.issues)).toBe(true);
    }
  });
});

describe("isConfigured", () => {
  it("is the one-way completion mark, not the presence of an admin", () => {
    expect(isConfigured(null)).toBe(false);
    expect(isConfigured({ setupCompletedAt: null })).toBe(false);
    expect(isConfigured({ setupCompletedAt: new Date("2026-09-23T10:00:00Z") })).toBe(true);
  });
});
