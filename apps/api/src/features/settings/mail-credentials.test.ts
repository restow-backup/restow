import { generateKeyPairSync } from "node:crypto";
import { parseSourceAppSecret } from "@restow/core";
import { describe, expect, it, vi } from "vitest";
import { ProblemError } from "../../problem.js";
import {
  type CurrentSettings,
  type MailEnvironment,
  decideGoogleKey,
  decideGraphApp,
  planSettingsUpdate,
  readStoredMailConfig,
  toMailView,
} from "./logic.js";
import { type GraphInput, mailInputSchema, updateSettingsSchema } from "./schemas.js";

/** Self-signed certificates built in memory (@restow/core test helper, not part of its API). */
const testing = await vi.importActual<{
  createTestCertificate: (options?: { notBefore?: Date; notAfter?: Date }) => {
    combinedPem: string;
    certificatePem: string;
  };
}>("../../../../../packages/core/src/entra/testing/certificate.js");

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const env: MailEnvironment = { graphTenantIdDefault: null, graphAppConfigured: false };

const smtpCurrent: CurrentSettings = {
  operatingMode: "local",
  publicUrl: null,
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

const ownCurrent: CurrentSettings = {
  operatingMode: "local",
  publicUrl: null,
  mail: {
    transport: "graph",
    sender: "alerts@contoso.com",
    tenantId: TENANT,
    app: "own",
    clientId: CLIENT_ID,
    credentialKind: "secret",
  },
  smtpPasswordStored: false,
  graphAppStored: true,
};

const googleCurrent: CurrentSettings = {
  operatingMode: "local",
  publicUrl: null,
  mail: {
    transport: "google",
    sender: "alerts@example.com",
    serviceAccountEmail: "notify@p.iam.gserviceaccount.com",
    clientId: "112233445566778899",
  },
  smtpPasswordStored: false,
  googleKeyStored: true,
};

function ownGraph(overrides: Partial<NonNullable<GraphInput["ownApp"]>> = {}): GraphInput {
  return {
    sender: "alerts@contoso.com",
    tenantId: TENANT,
    app: "own",
    ownApp: { clientId: CLIENT_ID, credentialKind: "secret", ...overrides },
  };
}

const KEY_FILE = JSON.stringify({
  type: "service_account",
  project_id: "p",
  private_key_id: "kid",
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
  client_email: "notify@p.iam.gserviceaccount.com",
  client_id: "112233445566778899",
});

function issuesOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemError);
    return (error as ProblemError).extensions?.issues;
  }
  throw new Error("expected a validation problem");
}

describe("request schema", () => {
  it("defaults Graph to the backup app, as before", () => {
    const parsed = mailInputSchema.parse({
      transport: "graph",
      graph: { sender: "a@contoso.com", tenantId: "contoso.onmicrosoft.com" },
    });
    expect(parsed).toMatchObject({ graph: { app: "backup" } });
  });

  it("needs the own app's details, a directory ID and no Secret ID", () => {
    const result = updateSettingsSchema.safeParse({
      mail: {
        transport: "graph",
        graph: {
          sender: "a@contoso.com",
          tenantId: "contoso.onmicrosoft.com",
          app: "own",
          ownApp: {
            clientId: "not-a-guid",
            credentialKind: "secret",
            clientSecret: "0f0e0d0c-0b0a-0908-0706-050403020100",
          },
        },
      },
    });
    expect(result.success).toBe(false);
    const issues = result.error?.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`);
    expect(issues).toEqual(
      expect.arrayContaining([
        "mail.graph.ownApp.clientId:guid",
        "mail.graph.ownApp.clientSecret:secretIsId",
        "mail.graph.tenantId:tenantGuid",
      ]),
    );
    const missing = updateSettingsSchema.safeParse({
      mail: { transport: "graph", graph: { sender: "a@contoso.com", app: "own" } },
    });
    expect(missing.error?.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining(["mail.graph.ownApp", "mail.graph.tenantId"]),
    );
  });

  it("accepts Google with or without a new key", () => {
    expect(
      mailInputSchema.safeParse({ transport: "google", google: { sender: "a@example.com" } })
        .success,
    ).toBe(true);
    expect(
      mailInputSchema.safeParse({
        transport: "google",
        google: { sender: "not-an-address", serviceAccountKey: "{}" },
      }).success,
    ).toBe(false);
  });
});

describe("decideGraphApp", () => {
  it("needs no own credential for the backup app", () => {
    expect(
      decideGraphApp({ sender: "a@contoso.com", tenantId: null, app: "backup" }, smtpCurrent),
    ).toEqual({ kind: "backup" });
  });

  it("builds the sealed document from a new client secret", () => {
    const decision = decideGraphApp(ownGraph({ clientSecret: "s3cr3t~value" }), smtpCurrent);
    expect(decision.kind).toBe("provided");
    if (decision.kind !== "provided") {
      return;
    }
    expect(decision.credentials).toEqual({
      clientId: CLIENT_ID,
      credential: { type: "secret", clientSecret: "s3cr3t~value" },
    });
    expect(decision.document).toMatchObject({ clientId: CLIENT_ID, credentialKind: "secret" });
  });

  it("checks a certificate and keeps only key and certificate", () => {
    const certificate = testing.createTestCertificate();
    const decision = decideGraphApp(
      ownGraph({
        credentialKind: "certificate",
        certificatePem: `junk\n${certificate.combinedPem}`,
      }),
      smtpCurrent,
    );
    expect(decision.kind).toBe("provided");
    if (decision.kind === "provided") {
      expect(decision.document.certificatePem).not.toContain("junk");
      expect(parseSourceAppSecret(JSON.stringify(decision.document))?.credential.type).toBe(
        "certificate",
      );
    }
    expect(
      decideGraphApp(
        ownGraph({ credentialKind: "certificate", certificatePem: certificate.certificatePem }),
        smtpCurrent,
      ),
    ).toEqual({
      kind: "invalid",
      issue: { path: ["mail", "graph", "ownApp", "certificatePem"], message: "privateKeyMissing" },
    });
  });

  it("reuses the stored credential only for the same tenant, app and credential kind", () => {
    expect(decideGraphApp(ownGraph(), ownCurrent)).toEqual({ kind: "stored" });
    expect(decideGraphApp({ ...ownGraph(), tenantId: TENANT.toUpperCase() }, ownCurrent)).toEqual({
      kind: "stored",
    });
    const required = {
      kind: "invalid",
      issue: { path: ["mail", "graph", "ownApp", "clientSecret"], message: "credentialRequired" },
    };
    expect(
      decideGraphApp(ownGraph({ clientId: "99999999-8888-7777-6666-555555555555" }), ownCurrent),
    ).toEqual(required);
    expect(
      decideGraphApp(
        { ...ownGraph(), tenantId: "22222222-2222-3333-4444-555555555555" },
        ownCurrent,
      ),
    ).toEqual(required);
    expect(decideGraphApp(ownGraph(), { ...ownCurrent, graphAppStored: false })).toEqual(required);
    expect(decideGraphApp(ownGraph({ credentialKind: "certificate" }), ownCurrent)).toEqual({
      kind: "invalid",
      issue: {
        path: ["mail", "graph", "ownApp", "certificatePem"],
        message: "credentialRequired",
      },
    });
  });
});

describe("decideGoogleKey", () => {
  it("parses a new key and keeps only its facts in the settings", () => {
    const decision = decideGoogleKey(
      { sender: "alerts@example.com", serviceAccountKey: KEY_FILE },
      smtpCurrent,
    );
    expect(decision.kind).toBe("provided");
    if (decision.kind === "provided") {
      expect(decision.key.clientId).toBe("112233445566778899");
      expect(JSON.parse(decision.plaintext)).toMatchObject({ type: "service_account" });
    }
  });

  it("refuses something that is not a key, and a missing key", () => {
    expect(
      decideGoogleKey({ sender: "a@example.com", serviceAccountKey: '{"type":1}' }, smtpCurrent),
    ).toEqual({
      kind: "invalid",
      issue: { path: ["mail", "google", "serviceAccountKey"], message: "serviceAccountKey" },
    });
    expect(decideGoogleKey({ sender: "a@example.com" }, smtpCurrent)).toEqual({
      kind: "invalid",
      issue: { path: ["mail", "google", "serviceAccountKey"], message: "required" },
    });
  });

  it("keeps the stored key while the transport stays Google", () => {
    expect(decideGoogleKey({ sender: "other@example.com" }, googleCurrent)).toEqual({
      kind: "stored",
      facts: {
        serviceAccountEmail: "notify@p.iam.gserviceaccount.com",
        clientId: "112233445566778899",
      },
    });
  });
});

describe("planSettingsUpdate with the new transports", () => {
  it("stores the own app's public facts and seals its credential, deleting the SMTP password", () => {
    const plan = planSettingsUpdate(
      smtpCurrent,
      { mail: { transport: "graph", graph: ownGraph({ clientSecret: "s3cr3t~value" }) } },
      env,
    );
    expect(plan.mail).toEqual({
      transport: "graph",
      sender: "alerts@contoso.com",
      tenantId: TENANT,
      app: "own",
      clientId: CLIENT_ID,
      credentialKind: "secret",
    });
    expect(plan.secrets.smtpPassword).toEqual({ action: "delete" });
    expect(plan.secrets.googleKey).toEqual({ action: "keep" });
    expect(plan.secrets.graphApp.action).toBe("set");
    expect(plan.changes).toEqual(["mail.transport", "mail.password", "mail.graphAppCredential"]);
    expect(JSON.stringify([plan.mail, plan.changes])).not.toContain("s3cr3t");
  });

  it("does not need a tenant from the environment for the own app", () => {
    const plan = planSettingsUpdate(
      ownCurrent,
      { mail: { transport: "graph", graph: ownGraph() } },
      env,
    );
    expect(plan.changes).toEqual([]);
    expect(plan.secrets.graphApp).toEqual({ action: "keep" });
  });

  it("deletes the own app's credential when Graph goes back to the backup app", () => {
    const plan = planSettingsUpdate(
      ownCurrent,
      {
        mail: {
          transport: "graph",
          graph: { sender: "alerts@contoso.com", tenantId: TENANT, app: "backup" },
        },
      },
      env,
    );
    expect(plan.mail).toEqual({
      transport: "graph",
      sender: "alerts@contoso.com",
      tenantId: TENANT,
    });
    expect(plan.secrets.graphApp).toEqual({ action: "delete" });
    expect(plan.changes).toEqual([
      "mail.app",
      "mail.clientId",
      "mail.credentialKind",
      "mail.graphAppCredential",
    ]);
  });

  it("switches to Google with a key and drops the own app", () => {
    const plan = planSettingsUpdate(
      ownCurrent,
      {
        mail: {
          transport: "google",
          google: { sender: "alerts@example.com", serviceAccountKey: KEY_FILE },
        },
      },
      env,
    );
    expect(plan.mail).toEqual({
      transport: "google",
      sender: "alerts@example.com",
      serviceAccountEmail: "notify@p.iam.gserviceaccount.com",
      clientId: "112233445566778899",
    });
    expect(plan.secrets.googleKey.action).toBe("set");
    expect(plan.secrets.graphApp).toEqual({ action: "delete" });
  });

  it("refuses Google without any key", () => {
    expect(
      issuesOf(() =>
        planSettingsUpdate(
          smtpCurrent,
          { mail: { transport: "google", google: { sender: "alerts@example.com" } } },
          env,
        ),
      ),
    ).toEqual([{ path: ["mail", "google", "serviceAccountKey"], message: "required" }]);
  });
});

describe("stored configuration and views", () => {
  it("reads the new shapes and refuses an own app without its facts", () => {
    expect(readStoredMailConfig("graph", ownCurrent.mail)).toEqual(ownCurrent.mail);
    expect(readStoredMailConfig("google", googleCurrent.mail)).toEqual(googleCurrent.mail);
    expect(
      readStoredMailConfig("graph", { transport: "graph", sender: "a@b.co", app: "own" }),
    ).toBeNull();
  });

  it("shows public facts and whether a credential is stored, never the credential", () => {
    expect(toMailView(ownCurrent.mail, { smtpPassword: false, graphApp: true })).toEqual({
      transport: "graph",
      graph: {
        sender: "alerts@contoso.com",
        tenantId: TENANT,
        app: "own",
        ownApp: { clientId: CLIENT_ID, credentialKind: "secret", credentialStored: true },
      },
    });
    expect(toMailView(googleCurrent.mail, { smtpPassword: false, googleKey: true })).toEqual({
      transport: "google",
      google: {
        sender: "alerts@example.com",
        serviceAccountEmail: "notify@p.iam.gserviceaccount.com",
        clientId: "112233445566778899",
        keyStored: true,
      },
    });
    expect(
      toMailView({ transport: "graph", sender: "a@b.co" }, { smtpPassword: false }),
    ).toMatchObject({ graph: { app: "backup", ownApp: null } });
  });
});
