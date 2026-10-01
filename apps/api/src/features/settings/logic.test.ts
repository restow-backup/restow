import { describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import {
  type CurrentSettings,
  type MailEnvironment,
  decideSmtpPassword,
  environmentView,
  mayReuseStoredPassword,
  planSettingsUpdate,
  readStoredMailConfig,
  toMailView,
  toSettingsView,
  toStoredMail,
} from "./logic.js";
import type { SmtpInput, UpdateSettingsInput } from "./schemas.js";

const env: MailEnvironment = { graphTenantIdDefault: null, graphAppConfigured: true };

const smtpCurrent: CurrentSettings = {
  operatingMode: "public",
  publicUrl: "https://restow.example.com",
  mail: {
    transport: "smtp",
    host: "smtp.example.com",
    port: 587,
    security: "starttls",
    from: "restow@example.com",
    username: "restow",
  },
  smtpPasswordStored: true,
};

const smtpDraft: SmtpInput = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  from: "restow@example.com",
  username: "restow",
  password: undefined,
};

function issuesOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemError);
    const problem = error as ProblemError;
    expect(problem.status).toBe(422);
    return problem.extensions?.issues;
  }
  throw new Error("expected a validation problem");
}

describe("readStoredMailConfig", () => {
  it("reads a well-formed configuration for the stored transport", () => {
    expect(readStoredMailConfig("smtp", smtpCurrent.mail)).toEqual(smtpCurrent.mail);
    expect(
      readStoredMailConfig("graph", { transport: "graph", sender: "a@b.co", tenantId: "t.co" }),
    ).toEqual({ transport: "graph", sender: "a@b.co", tenantId: "t.co" });
  });

  it("treats a missing, malformed or mismatched configuration as not configured", () => {
    expect(readStoredMailConfig(null, smtpCurrent.mail)).toBeNull();
    expect(readStoredMailConfig("graph", smtpCurrent.mail)).toBeNull();
    expect(readStoredMailConfig("smtp", { transport: "smtp", host: "x" })).toBeNull();
    expect(readStoredMailConfig("smtp", null)).toBeNull();
  });
});

describe("toStoredMail", () => {
  it("stores the contract's `tls` as `implicit` and drops an empty username", () => {
    expect(
      toStoredMail({
        transport: "smtp",
        smtp: { ...smtpDraft, security: "tls", port: 465, username: null, password: "x" },
      }),
    ).toEqual({
      transport: "smtp",
      host: "smtp.example.com",
      port: 465,
      security: "implicit",
      from: "restow@example.com",
    });
  });

  it("never stores the password", () => {
    const stored = toStoredMail({ transport: "smtp", smtp: { ...smtpDraft, password: "secret" } });
    expect(JSON.stringify(stored)).not.toContain("secret");
  });

  it("keeps the Graph tenant only when one is given", () => {
    expect(
      toStoredMail({ transport: "graph", graph: { sender: "a@b.co", tenantId: null } }),
    ).toEqual({ transport: "graph", sender: "a@b.co" });
  });
});

describe("SMTP password reuse", () => {
  it("reuses the stored password for the same host (any case) and user", () => {
    expect(mayReuseStoredPassword(smtpDraft, smtpCurrent)).toBe(true);
    expect(mayReuseStoredPassword({ ...smtpDraft, host: "SMTP.Example.com" }, smtpCurrent)).toBe(
      true,
    );
    expect(decideSmtpPassword(smtpDraft, smtpCurrent)).toEqual({ kind: "stored" });
  });

  it("never hands the stored password to another host or user", () => {
    expect(mayReuseStoredPassword({ ...smtpDraft, host: "smtp.other.com" }, smtpCurrent)).toBe(
      false,
    );
    expect(mayReuseStoredPassword({ ...smtpDraft, username: "someone" }, smtpCurrent)).toBe(false);
    expect(decideSmtpPassword({ ...smtpDraft, host: "smtp.other.com" }, smtpCurrent)).toEqual({
      kind: "invalid",
      issue: { path: ["mail", "smtp", "password"], message: "passwordRequired" },
    });
  });

  it("needs a password when none is stored", () => {
    expect(decideSmtpPassword(smtpDraft, { ...smtpCurrent, smtpPasswordStored: false }).kind).toBe(
      "invalid",
    );
  });

  it("uses a submitted password as is", () => {
    expect(decideSmtpPassword({ ...smtpDraft, password: "new-secret" }, smtpCurrent)).toEqual({
      kind: "provided",
      password: "new-secret",
    });
  });

  it("sends unauthenticated without a username, but refuses a password without one", () => {
    expect(decideSmtpPassword({ ...smtpDraft, username: null }, smtpCurrent)).toEqual({
      kind: "none",
    });
    expect(
      decideSmtpPassword({ ...smtpDraft, username: null, password: "x" }, smtpCurrent),
    ).toEqual({
      kind: "invalid",
      issue: { path: ["mail", "smtp", "username"], message: "usernameRequired" },
    });
  });
});

describe("planSettingsUpdate", () => {
  it("switches to local mode and drops the public URL", () => {
    const plan = planSettingsUpdate(smtpCurrent, { operatingMode: "local" }, env);
    expect(plan.operatingMode).toBe("local");
    expect(plan.publicUrl).toBeNull();
    expect(plan.secret).toEqual({ action: "keep" });
    expect(plan.changes).toEqual(["operatingMode", "publicUrl"]);
  });

  it("requires a public URL for public mode", () => {
    const local: CurrentSettings = { ...smtpCurrent, operatingMode: "local", publicUrl: null };
    expect(issuesOf(() => planSettingsUpdate(local, { operatingMode: "public" }, env))).toEqual([
      { path: ["publicUrl"], message: "required" },
    ]);
    const plan = planSettingsUpdate(
      local,
      { operatingMode: "public", publicUrl: "https://new.example.com" },
      env,
    );
    expect(plan.publicUrl).toBe("https://new.example.com");
  });

  it("changes only the URL when that is all the patch says", () => {
    const plan = planSettingsUpdate(smtpCurrent, { publicUrl: "https://backup.example.com" }, env);
    expect(plan.changes).toEqual(["publicUrl"]);
    expect(plan.mail).toBe(smtpCurrent.mail);
  });

  it("reports nothing to change for an identical patch", () => {
    const patch: UpdateSettingsInput = {
      operatingMode: "public",
      publicUrl: "https://restow.example.com",
      mail: { transport: "smtp", smtp: smtpDraft },
    };
    const plan = planSettingsUpdate(smtpCurrent, patch, env);
    expect(plan.changes).toEqual([]);
    expect(plan.secret).toEqual({ action: "keep" });
  });

  it("names changed SMTP fields and a new password without its value", () => {
    const plan = planSettingsUpdate(
      smtpCurrent,
      { mail: { transport: "smtp", smtp: { ...smtpDraft, port: 2525, password: "rotated" } } },
      env,
    );
    expect(plan.changes).toEqual(["mail.port", "mail.password"]);
    expect(plan.secret).toEqual({ action: "set", plaintext: "rotated" });
    expect(JSON.stringify(plan.changes)).not.toContain("rotated");
  });

  it("deletes the stored password when the relay no longer authenticates", () => {
    const plan = planSettingsUpdate(
      smtpCurrent,
      { mail: { transport: "smtp", smtp: { ...smtpDraft, username: null } } },
      env,
    );
    expect(plan.secret).toEqual({ action: "delete" });
    expect(plan.changes).toEqual(["mail.username", "mail.password"]);
  });

  it("deletes the stored password when switching to Graph", () => {
    const plan = planSettingsUpdate(
      smtpCurrent,
      {
        mail: {
          transport: "graph",
          graph: { sender: "restow@contoso.com", tenantId: "contoso.onmicrosoft.com" },
        },
      },
      env,
    );
    expect(plan.mail).toEqual({
      transport: "graph",
      sender: "restow@contoso.com",
      tenantId: "contoso.onmicrosoft.com",
    });
    expect(plan.secret).toEqual({ action: "delete" });
    expect(plan.changes).toEqual(["mail.transport", "mail.password"]);
  });

  it("requires a Graph tenant unless the environment provides one", () => {
    const patch: UpdateSettingsInput = {
      mail: { transport: "graph", graph: { sender: "restow@contoso.com", tenantId: null } },
    };
    expect(issuesOf(() => planSettingsUpdate(smtpCurrent, patch, env))).toEqual([
      { path: ["mail", "graph", "tenantId"], message: "required" },
    ]);
    const plan = planSettingsUpdate(smtpCurrent, patch, {
      ...env,
      graphTenantIdDefault: "contoso.onmicrosoft.com",
    });
    expect(plan.mail).toEqual({ transport: "graph", sender: "restow@contoso.com" });
  });

  it("collects every problem before failing", () => {
    const local: CurrentSettings = { ...smtpCurrent, operatingMode: "local", publicUrl: null };
    const issues = issuesOf(() =>
      planSettingsUpdate(
        local,
        {
          operatingMode: "public",
          mail: { transport: "smtp", smtp: { ...smtpDraft, host: "smtp.other.com" } },
        },
        env,
      ),
    );
    expect(issues).toEqual([
      { path: ["publicUrl"], message: "required" },
      { path: ["mail", "smtp", "password"], message: "passwordRequired" },
    ]);
  });
});

describe("views", () => {
  it("shows the SMTP transport with the contract spelling and only whether a password exists", () => {
    const view = toMailView({ ...smtpCurrent.mail, security: "implicit" } as never, true);
    expect(view).toEqual({
      transport: "smtp",
      smtp: {
        host: "smtp.example.com",
        port: 587,
        security: "tls",
        from: "restow@example.com",
        username: "restow",
        passwordStored: true,
      },
    });
    expect(toMailView(null, false)).toEqual({ transport: null });
  });

  it("flags an environment public URL that differs from the saved one", () => {
    expect(environmentView("https://old.example.com/", "https://new.example.com")).toEqual({
      publicUrl: "https://old.example.com",
      publicUrlMismatch: true,
    });
    expect(environmentView("https://restow.example.com/", "https://restow.example.com")).toEqual({
      publicUrl: "https://restow.example.com",
      publicUrlMismatch: false,
    });
    expect(environmentView(undefined, "https://restow.example.com").publicUrlMismatch).toBe(false);
    expect(environmentView("https://restow.example.com", null).publicUrlMismatch).toBe(false);
  });

  it("builds the response without secrets and with ISO timestamps", () => {
    const view = toSettingsView({
      operatingMode: "public",
      publicUrl: "https://restow.example.com",
      mail: smtpCurrent.mail,
      smtpPasswordStored: true,
      updatedAt: new Date("2026-09-20T08:00:00.000Z"),
      passkeyReady: { ready: true, reasons: [], rpId: "restow.example.com", origin: null },
      environmentPublicUrl: null,
      mailEnvironment: {
        graphTenantIdDefault: "contoso.onmicrosoft.com",
        graphAppConfigured: false,
      },
    });
    expect(view.updatedAt).toBe("2026-09-20T08:00:00.000Z");
    expect(view.capabilities.graphMail).toEqual({
      appConfigured: false,
      defaultTenantId: "contoso.onmicrosoft.com",
    });
    expect(Object.keys(view).sort()).toEqual([
      "capabilities",
      "environment",
      "mail",
      "operatingMode",
      "passkeyReady",
      "publicUrl",
      "updatedAt",
    ]);
  });
});
