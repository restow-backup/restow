import { describe, expect, it } from "vitest";

import {
  STEP_KEYS,
  type SetupFormValues,
  buildSubmission,
  defaultSetupValues,
  publicUrlReason,
  setupFormSchema,
} from "./schema";

function valid(overrides: Partial<SetupFormValues> = {}): SetupFormValues {
  return {
    ...defaultSetupValues,
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
  it("puts the setup token and the operator notice before everything else and the review last", () => {
    expect(STEP_KEYS).toEqual(["token", "disclaimer", "mode", "admin", "mail", "review"]);
  });
});

describe("setupFormSchema", () => {
  it("accepts a complete local SMTP setup", () => {
    expect(issuePaths(valid())).toEqual([]);
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

describe("buildSubmission", () => {
  it("maps the SMTP form onto the API contract and drops empty optionals", () => {
    const submission = buildSubmission(valid(), "2026-09-30");
    expect(submission).toEqual({
      disclaimer: { version: "2026-09-30", accepted: true },
      operatingMode: "local",
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

  it("includes credentials and the trimmed public URL when given", () => {
    const values = valid({ operatingMode: "public", publicUrl: " https://restow.example.com/ " });
    values.mail.smtp = { ...values.mail.smtp, username: " user ", password: "secret" };
    const submission = buildSubmission(values, "2026-09-30");
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
      graph: { sender: "restow@example.com", tenantId: " 1111 " },
    };
    expect(buildSubmission(values, "2026-09-30").mail).toEqual({
      transport: "graph",
      graph: { sender: "restow@example.com", tenantId: "1111" },
    });
  });
});
