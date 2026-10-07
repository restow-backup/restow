import { describe, expect, it } from "vitest";

import type { InstallationSettings } from "./api";
import {
  type MailFormContext,
  type MailFormValues,
  fieldMessageKey,
  generalFormSchema,
  leavesPublicMode,
  mailFormContext,
  mailFormFromSettings,
  mailFormSchema,
  mayKeepStoredPassword,
  passkeyLoss,
  passwordConfirmSchema,
  portForSecurity,
  problemFieldIssues,
  publicUrlOrigin,
  publicUrlReason,
  toGeneralPatch,
  toMailInput,
  totpCodeSchema,
} from "./forms";

const settings: InstallationSettings = {
  operatingMode: "public",
  publicUrl: "https://restow.example.com",
  passkeyReady: { ready: true, reasons: [], rpId: "restow.example.com", origin: null },
  environment: { publicUrl: null, publicUrlMismatch: false },
  mail: {
    transport: "smtp",
    smtp: {
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      from: "restow@example.com",
      username: "restow",
      passwordStored: true,
    },
  },
  capabilities: { graphMail: { appConfigured: true, defaultTenantId: null } },
  disclaimer: {
    acceptedVersion: "2026-10-01",
    acceptedAt: "2026-09-20T07:00:00.000Z",
    currentVersion: "2026-10-01",
  },
  updatedAt: "2026-09-20T08:00:00.000Z",
};

const context = mailFormContext(settings);

function messages(result: {
  success: boolean;
  error?: { issues: { path: unknown[]; message: string }[] };
}) {
  return result.success
    ? []
    : (result.error?.issues.map((issue) => [issue.path.join("."), issue.message]) ?? []);
}

function smtpValues(overrides: Partial<MailFormValues["smtp"]> = {}): MailFormValues {
  const values = mailFormFromSettings(settings.mail);
  return { ...values, smtp: { ...values.smtp, ...overrides } };
}

describe("publicUrlReason", () => {
  it("accepts HTTPS origins and the localhost exception", () => {
    expect(publicUrlReason("https://restow.example.com")).toBeNull();
    expect(publicUrlReason("https://restow.example.com/")).toBeNull();
    expect(publicUrlReason("http://localhost:5173")).toBeNull();
  });

  it("names every other problem like the API does", () => {
    expect(publicUrlReason("  ")).toBe("required");
    expect(publicUrlReason("restow.example.com")).toBe("url");
    expect(publicUrlReason("http://restow.example.com")).toBe("httpsRequired");
    expect(publicUrlReason("https://restow.example.com/app")).toBe("originOnly");
    expect(publicUrlReason("https://10.0.0.5")).toBe("domainRequired");
  });

  it("reduces a valid URL to its origin", () => {
    expect(publicUrlOrigin("https://Restow.Example.com/")).toBe("https://restow.example.com");
    expect(publicUrlOrigin("http://restow.example.com")).toBeNull();
  });
});

describe("general form", () => {
  it("validates the URL only in public mode", () => {
    expect(generalFormSchema.safeParse({ operatingMode: "local", publicUrl: "" }).success).toBe(
      true,
    );
    expect(
      messages(generalFormSchema.safeParse({ operatingMode: "public", publicUrl: "" })),
    ).toEqual([["publicUrl", "required"]]);
  });

  it("sends only what changed", () => {
    expect(
      toGeneralPatch(
        { operatingMode: "public", publicUrl: "https://restow.example.com/" },
        settings,
      ),
    ).toBeNull();
    expect(
      toGeneralPatch(
        { operatingMode: "public", publicUrl: "https://backup.example.com" },
        settings,
      ),
    ).toEqual({ publicUrl: "https://backup.example.com" });
    expect(toGeneralPatch({ operatingMode: "local", publicUrl: "" }, settings)).toEqual({
      operatingMode: "local",
    });
  });

  it("asks before leaving public mode", () => {
    expect(leavesPublicMode({ operatingMode: "local", publicUrl: "" }, settings)).toBe(true);
    expect(
      leavesPublicMode(
        { operatingMode: "public", publicUrl: "" },
        { ...settings, operatingMode: "local" },
      ),
    ).toBe(false);
  });

  it("knows when passkeys would stop working", () => {
    expect(passkeyLoss({ operatingMode: "local", publicUrl: "" }, settings)).toBe("leave_public");
    expect(
      passkeyLoss({ operatingMode: "public", publicUrl: "https://backup.example.com" }, settings),
    ).toBe("host_change");
    // Same host, other port or path: the passkeys stay valid.
    expect(
      passkeyLoss(
        { operatingMode: "public", publicUrl: "https://restow.example.com:8443" },
        settings,
      ),
    ).toBeNull();
    expect(
      passkeyLoss({ operatingMode: "public", publicUrl: "https://restow.example.com" }, settings),
    ).toBeNull();
    // From local mode no passkey works yet, so nothing is lost.
    expect(
      passkeyLoss(
        { operatingMode: "public", publicUrl: "https://backup.example.com" },
        { ...settings, operatingMode: "local" },
      ),
    ).toBeNull();
  });
});

describe("mail form", () => {
  it("starts from the stored transport without the password", () => {
    expect(mailFormFromSettings(settings.mail)).toEqual({
      transport: "smtp",
      smtp: {
        host: "smtp.example.com",
        port: "587",
        security: "starttls",
        username: "restow",
        password: "",
        from: "restow@example.com",
      },
      graph: {
        app: "own",
        sender: "",
        tenantId: "",
        clientId: "",
        credentialKind: "secret",
        clientSecret: "",
        certificatePem: "",
      },
      google: { sender: "", serviceAccountKey: "" },
    });
    expect(mailFormFromSettings({ transport: null }).transport).toBe("smtp");
  });

  it("keeps the stored password only for the same host and username", () => {
    expect(
      mayKeepStoredPassword({ host: "SMTP.example.com", username: "restow" }, context.storedSmtp),
    ).toBe(true);
    expect(
      mayKeepStoredPassword({ host: "smtp.other.com", username: "restow" }, context.storedSmtp),
    ).toBe(false);
    expect(
      mayKeepStoredPassword({ host: "smtp.example.com", username: "ops" }, context.storedSmtp),
    ).toBe(false);
    expect(mayKeepStoredPassword({ host: "smtp.example.com", username: "restow" }, null)).toBe(
      false,
    );
  });

  it("accepts the unchanged stored transport", () => {
    expect(mailFormSchema(context).safeParse(smtpValues()).success).toBe(true);
  });

  it("asks for the password again when host or username change", () => {
    expect(
      messages(mailFormSchema(context).safeParse(smtpValues({ host: "smtp.other.com" }))),
    ).toEqual([["smtp.password", "passwordRequired"]]);
    expect(
      mailFormSchema(context).safeParse(smtpValues({ host: "smtp.other.com", password: "pw" }))
        .success,
    ).toBe(true);
  });

  it("validates host, port, sender and a password without username", () => {
    const result = mailFormSchema(context).safeParse(
      smtpValues({ host: "bad host", port: "99999", from: "", username: "", password: "pw" }),
    );
    expect(messages(result)).toEqual([
      ["smtp.host", "host"],
      ["smtp.port", "port"],
      ["smtp.from", "required"],
      ["smtp.username", "usernameRequired"],
    ]);
  });

  it("validates only the selected transport", () => {
    const graphOnly: MailFormValues = {
      ...smtpValues(),
      transport: "graph",
      smtp: { host: "", port: "", security: "starttls", username: "", password: "", from: "" },
      graph: {
        ...smtpValues().graph,
        app: "backup",
        sender: "restow@contoso.com",
        tenantId: "contoso.onmicrosoft.com",
      },
    };
    expect(mailFormSchema(context).safeParse(graphOnly).success).toBe(true);
  });

  it("requires a Graph tenant unless the server provides a default", () => {
    const values: MailFormValues = {
      ...smtpValues(),
      transport: "graph",
      graph: { ...smtpValues().graph, app: "backup", sender: "restow@contoso.com", tenantId: "" },
    };
    expect(messages(mailFormSchema(context).safeParse(values))).toEqual([
      ["graph.tenantId", "required"],
    ]);
    const withDefault: MailFormContext = {
      ...context,
      graphDefaultTenantId: "contoso.onmicrosoft.com",
    };
    expect(mailFormSchema(withDefault).safeParse(values).success).toBe(true);
    expect(
      messages(
        mailFormSchema(context).safeParse({
          ...values,
          graph: { ...values.graph, sender: "x", tenantId: "nope" },
        }),
      ),
    ).toEqual([
      ["graph.sender", "email"],
      ["graph.tenantId", "tenantId"],
    ]);
  });

  it("builds the API payload without an empty password", () => {
    expect(toMailInput(smtpValues({ username: "  ", host: " smtp.example.com " }))).toEqual({
      transport: "smtp",
      smtp: {
        host: "smtp.example.com",
        port: 587,
        security: "starttls",
        from: "restow@example.com",
        username: null,
      },
    });
    expect(toMailInput(smtpValues({ password: "rotated" }))).toMatchObject({
      smtp: { password: "rotated", username: "restow" },
    });
    expect(
      toMailInput({
        ...smtpValues(),
        transport: "graph",
        graph: {
          ...smtpValues().graph,
          app: "backup",
          sender: " restow@contoso.com ",
          tenantId: " ",
        },
      }),
    ).toEqual({
      transport: "graph",
      graph: { sender: "restow@contoso.com", tenantId: null, app: "backup" },
    });
  });

  it("follows the conventional port unless a custom one was typed", () => {
    expect(portForSecurity("587", "tls")).toBe("465");
    expect(portForSecurity("", "none")).toBe("25");
    expect(portForSecurity("2525", "tls")).toBe("2525");
  });
});

describe("field messages", () => {
  it("maps settings reasons to the settings namespace and the rest to common", () => {
    expect(fieldMessageKey({ type: "custom", message: "passwordRequired" })).toBe(
      "settings:validation.passwordRequired",
    );
    expect(fieldMessageKey({ type: "custom", message: "email" })).toBe("common:validation.email");
    expect(fieldMessageKey({ type: "custom", message: "Something zod said" })).toBe(
      "common:validation.required",
    );
    expect(fieldMessageKey(undefined)).toBeUndefined();
  });
});

describe("problemFieldIssues", () => {
  const problem = (issues: unknown) => ({
    status: 422,
    problem: { type: "about:blank", title: "Validation failed", status: 422, issues },
  });

  it("re-roots API issue paths onto the form", () => {
    const error = problem([
      { path: ["mail", "smtp", "password"], message: "passwordRequired" },
      { path: ["publicUrl"], message: "required" },
    ]);
    expect(problemFieldIssues(error, ["mail"])).toEqual([
      { field: "smtp.password", reason: "passwordRequired" },
    ]);
    expect(problemFieldIssues(error)).toEqual([
      { field: "mail.smtp.password", reason: "passwordRequired" },
      { field: "publicUrl", reason: "required" },
    ]);
  });

  it("ignores anything that is not a validation problem", () => {
    expect(problemFieldIssues(new Error("boom"))).toEqual([]);
    expect(problemFieldIssues({ status: 409, problem: { issues: [] } })).toEqual([]);
    expect(problemFieldIssues(problem("not a list"))).toEqual([]);
  });
});

describe("authenticator forms", () => {
  it("accepts the six-digit code, with spaces an app shows or a paste brings along", () => {
    expect(totpCodeSchema.parse({ code: "123456" })).toEqual({ code: "123456" });
    expect(totpCodeSchema.parse({ code: " 123 456 " })).toEqual({ code: "123456" });
  });

  it("rejects anything that is not six digits, with the totp reason", () => {
    for (const code of ["", "12345", "1234567", "12345a"]) {
      const result = totpCodeSchema.safeParse({ code });
      expect(result.success, code).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("totp");
    }
  });

  it("requires the password before any change to the second factor", () => {
    expect(passwordConfirmSchema.safeParse({ password: "" }).success).toBe(false);
    expect(passwordConfirmSchema.safeParse({ password: "correct horse" }).success).toBe(true);
  });
});
