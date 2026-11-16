import { describe, expect, it } from "vitest";

import {
  browserTimeZone,
  buildSubmission,
  defaultSetupValues,
  initialSetupValues,
  ORGANISATION_NAME_MAX_LENGTH,
  publicUrlReason,
  SETUP_KINDS,
  SETUP_LANGUAGES,
  type SetupFormValues,
  STEP_FIELDS,
  STEP_KEYS,
  STEPS_BY_KIND,
  setupFormSchema,
} from "./schema";

function valid(overrides: Partial<SetupFormValues> = {}): SetupFormValues {
  return {
    ...defaultSetupValues,
    organisationName: "Example IT Services GmbH",
    admin: {
      name: "Lucas Flores",
      email: "admin@example.com",
      password: "correct horse battery",
      confirm: "correct horse battery",
    },
    mail: {
      ...defaultSetupValues.mail,
      smtp: {
        ...defaultSetupValues.mail.smtp,
        host: "smtp.example.com",
        from: "restow@example.com",
      },
    },
    ...overrides,
  };
}

function issuePaths(values: SetupFormValues): string[] {
  const result = setupFormSchema.safeParse(values);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

describe("STEP_KEYS", () => {
  it("starts with the language and the question what to set up, then the setup token, the operator notice and what to protect, and ends with the review", () => {
    expect(STEP_KEYS).toEqual([
      "language",
      "kind",
      "token",
      "disclaimer",
      "modules",
      "mode",
      "admin",
      "mail",
      "review",
    ]);
  });

  it("asks what to set up first, after the language, on every path", () => {
    expect([...SETUP_KINDS]).toEqual(["new", "restore", "worker"]);
    for (const kind of SETUP_KINDS) {
      expect(STEPS_BY_KIND[kind].slice(0, 2)).toEqual(["language", "kind"]);
    }
  });

  it("restores without the notice, the mode, a first admin or the mail, but with the setup token", () => {
    expect([...STEPS_BY_KIND.restore]).toEqual([
      "language",
      "kind",
      "token",
      "restoreSource",
      "restoreRun",
      "restoreDone",
    ]);
    for (const step of ["disclaimer", "mode", "admin", "mail", "review"] as const) {
      expect(STEPS_BY_KIND.restore as readonly string[]).not.toContain(step);
    }
  });

  it("explains a worker node without the token or any form", () => {
    expect([...STEPS_BY_KIND.worker]).toEqual(["language", "kind", "workerInfo"]);
  });

  it("offers English and German", () => {
    expect([...SETUP_LANGUAGES]).toEqual(["en", "de"]);
  });
});

describe("STEP_FIELDS", () => {
  it("validates the organisation name together with the first admin", () => {
    expect(STEP_FIELDS.admin).toEqual([
      "organisationName",
      "admin.name",
      "admin.email",
      "admin.password",
      "admin.confirm",
    ]);
  });
});

describe("setupFormSchema", () => {
  it("accepts a complete local SMTP setup", () => {
    expect(issuePaths(valid())).toEqual([]);
  });

  it("requires a name for the operator's own organisation, up to the length the API accepts", () => {
    expect(issuePaths(valid({ organisationName: "" }))).toEqual(["organisationName"]);
    expect(issuePaths(valid({ organisationName: "   " }))).toEqual(["organisationName"]);
    expect(
      issuePaths(valid({ organisationName: "x".repeat(ORGANISATION_NAME_MAX_LENGTH) })),
    ).toEqual([]);
    const tooLong = setupFormSchema.safeParse(
      valid({ organisationName: "x".repeat(ORGANISATION_NAME_MAX_LENGTH + 1) }),
    );
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) {
      expect(tooLong.error.issues[0]).toMatchObject({
        path: ["organisationName"],
        message: "maxLength",
      });
    }
    const missing = setupFormSchema.safeParse(valid({ organisationName: "" }));
    if (!missing.success) {
      expect(missing.error.issues[0]?.message).toBe("required");
    }
  });

  it("requires a usable public URL only in public mode", () => {
    expect(issuePaths(valid({ operatingMode: "public", publicUrl: "" }))).toContain("publicUrl");
    expect(issuePaths(valid({ operatingMode: "local", publicUrl: "" }))).toEqual([]);
    expect(
      issuePaths(valid({ operatingMode: "public", publicUrl: "https://restow.example.com" })),
    ).toEqual([]);
  });

  it("enforces the password rules with reason codes", () => {
    const short = valid();
    short.admin = { ...short.admin, password: "short", confirm: "short" };
    const result = setupFormSchema.safeParse(short);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ["admin", "password"],
        message: "minLength",
      });
    }

    const mismatch = valid();
    mismatch.admin = { ...mismatch.admin, confirm: "something else entirely" };
    expect(issuePaths(mismatch)).toEqual(["admin.confirm"]);
  });

  it("validates the transport that is selected, not the other one", () => {
    const smtp = valid();
    smtp.mail = { ...smtp.mail, smtp: { ...smtp.mail.smtp, host: "", port: "99999", from: "x" } };
    expect(issuePaths(smtp)).toEqual(["mail.smtp.host", "mail.smtp.port", "mail.smtp.from"]);

    const graph = valid();
    graph.mail = { ...graph.mail, transport: "graph", smtp: { ...graph.mail.smtp, host: "" } };
    expect(issuePaths(graph)).toEqual(["mail.graph.sender"]);
    graph.mail.graph = { sender: "restow@example.com", tenantId: "" };
    expect(issuePaths(graph)).toEqual([]);
    graph.mail.graph = { sender: "restow@example.com", tenantId: "contoso" };
    expect(issuePaths(graph)).toEqual(["mail.graph.tenantId"]);
    graph.mail.graph = { sender: "restow@example.com", tenantId: "contoso.onmicrosoft.com" };
    expect(issuePaths(graph)).toEqual([]);
  });

  it("validates no mail field when the step is skipped, however incomplete", () => {
    const skipped = valid();
    skipped.mail = {
      ...skipped.mail,
      skipped: true,
      smtp: { ...skipped.mail.smtp, host: "", port: "99999", from: "x" },
    };
    expect(issuePaths(skipped)).toEqual([]);
    skipped.mail = { ...skipped.mail, transport: "graph", graph: { sender: "x", tenantId: "" } };
    expect(issuePaths(skipped)).toEqual([]);
    // The rest of the form still counts.
    skipped.organisationName = "";
    expect(issuePaths(skipped)).toEqual(["organisationName"]);
  });

  it("does not skip the mail step by default", () => {
    expect(defaultSetupValues.mail.skipped).toBe(false);
    const incomplete = valid();
    incomplete.mail = { ...incomplete.mail, smtp: { ...incomplete.mail.smtp, host: "" } };
    expect(issuePaths(incomplete)).toEqual(["mail.smtp.host"]);
  });
});

describe("publicUrlReason", () => {
  it("explains what is wrong with a URL", () => {
    expect(publicUrlReason("")).toBe("required");
    expect(publicUrlReason("restow")).toBe("url");
    expect(publicUrlReason("http://restow.example.com")).toBe("httpsRequired");
    expect(publicUrlReason("http://localhost:5173")).toBeNull();
    expect(publicUrlReason("https://restow.example.com")).toBeNull();
  });
});

describe("the time zone", () => {
  it("starts with the browser's", () => {
    expect(initialSetupValues().timeZone).toBe(browserTimeZone());
    expect(browserTimeZone()).not.toBe("");
  });

  it("is validated on the operation step and sent when there is one", () => {
    expect(STEP_FIELDS.mode).toContain("timeZone");
    expect(buildSubmission(valid({ timeZone: "America/New_York" }), "v1", "en").timeZone).toBe(
      "America/New_York",
    );
    expect(buildSubmission(valid({ timeZone: "" }), "v1", "en")).not.toHaveProperty("timeZone");
  });
});

describe("the modules of the installation", () => {
  it("are all ticked to begin with, and their step validates only them", () => {
    expect(defaultSetupValues.modules).toEqual([
      "microsoft365",
      "imap",
      "archive",
      "endpoints",
      "pve",
    ]);
    expect(STEP_FIELDS.modules).toEqual(["modules"]);
  });

  it("need at least one module, and know only the modules of the list", () => {
    expect(issuePaths(valid({ modules: [] }))).toEqual(["modules"]);
    expect(issuePaths(valid({ modules: ["pve"] }))).toEqual([]);
    expect(issuePaths(valid({ modules: ["tape" as never] }))).toEqual(["modules.0"]);
  });

  it("are asked on a new installation only: a restore brings its own, a worker has none", () => {
    expect(STEPS_BY_KIND.new).toContain("modules");
    expect(STEPS_BY_KIND.new.indexOf("modules")).toBe(STEPS_BY_KIND.new.indexOf("disclaimer") + 1);
    expect([...STEPS_BY_KIND.restore]).not.toContain("modules");
    expect([...STEPS_BY_KIND.worker]).not.toContain("modules");
  });
});

describe("buildSubmission", () => {
  it("maps the SMTP form onto the API contract and drops empty optionals", () => {
    const submission = buildSubmission(valid(), "2026-09-30", "en");
    expect(submission).toEqual({
      disclaimer: { version: "2026-09-30", accepted: true },
      operatingMode: "local",
      providerName: "Example IT Services GmbH",
      language: "en",
      modules: ["microsoft365", "imap", "archive", "endpoints", "pve"],
      firstAdmin: {
        name: "Lucas Flores",
        email: "admin@example.com",
        password: "correct horse battery",
      },
      mail: {
        transport: "smtp",
        smtp: {
          host: "smtp.example.com",
          port: 587,
          security: "starttls",
          from: "restow@example.com",
        },
      },
      sendTest: true,
    });
    expect(submission).not.toHaveProperty("publicUrl");
  });

  it("sends the ticked modules in the order of the list, whatever order they were ticked in", () => {
    expect(
      buildSubmission(valid({ modules: ["pve", "microsoft365"] }), "2026-09-30", "en").modules,
    ).toEqual(["microsoft365", "pve"]);
  });

  it("sends the language chosen in the first step, German as well as English", () => {
    expect(buildSubmission(valid(), "2026-09-30", "de").language).toBe("de");
    expect(buildSubmission(valid(), "2026-09-30", "en").language).toBe("en");
  });

  it("sends no mail and no test message when the mail step was skipped", () => {
    const values = valid();
    values.mail = { ...values.mail, skipped: true };
    values.sendTest = true;
    const submission = buildSubmission(values, "2026-09-30", "de");
    expect(submission).not.toHaveProperty("mail");
    expect(submission.sendTest).toBe(false);
    // The rest of the request is as ever.
    expect(submission).toMatchObject({
      language: "de",
      providerName: "Example IT Services GmbH",
      firstAdmin: { email: "admin@example.com" },
    });
    // The SMTP details that were typed before skipping are not sent either.
    expect(JSON.stringify(submission)).not.toContain("smtp.example.com");
  });

  it("sends the name of the organisation trimmed, as the operator's name", () => {
    const submission = buildSubmission(
      valid({ organisationName: "  Müller IT GmbH  " }),
      "2026-09-30",
      "en",
    );
    expect(submission.providerName).toBe("Müller IT GmbH");
  });

  it("includes credentials and the trimmed public URL when given", () => {
    const values = valid({ operatingMode: "public", publicUrl: " https://restow.example.com/ " });
    values.mail.smtp = { ...values.mail.smtp, username: " user ", password: "secret" };
    const submission = buildSubmission(values, "2026-09-30", "en");
    expect(submission.publicUrl).toBe("https://restow.example.com");
    expect(submission.mail).toMatchObject({
      transport: "smtp",
      smtp: { username: "user", password: "secret" },
    });
  });

  it("maps the Graph transport", () => {
    const values = valid();
    values.mail = {
      ...values.mail,
      transport: "graph",
      graph: { sender: "restow@example.com", tenantId: " contoso.onmicrosoft.com " },
    };
    expect(buildSubmission(values, "2026-09-30", "en").mail).toEqual({
      transport: "graph",
      graph: { sender: "restow@example.com", tenantId: "contoso.onmicrosoft.com" },
    });
  });
});
