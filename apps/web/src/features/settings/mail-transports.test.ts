import { describe, expect, it } from "vitest";

import type { InstallationSettings } from "./api";
import {
  type MailFormValues,
  fieldMessageKey,
  mailFormContext,
  mailFormFromSettings,
  mailFormSchema,
  mayKeepGraphCredential,
  previewServiceAccountKey,
  toMailInput,
} from "./forms";
import { GMAIL_SEND_SCOPE, accessPolicyCommands, rbacCommands } from "./mail-guide";
import { mailTestFailureKey } from "./presenters";

/**
 * The Microsoft 365 (own app registration) and Google Workspace parts of the
 * notification mail form: validation mirrors the API, stored secrets are
 * kept only for the same app, the payload never carries an empty secret, and
 * the guide's commands carry what the form holds.
 */

const CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TENANT = "11111111-2222-3333-4444-555555555555";

function settings(mail: InstallationSettings["mail"]): InstallationSettings {
  return {
    operatingMode: "local",
    publicUrl: null,
    passkeyReady: { ready: false, reasons: [], rpId: null, origin: null },
    environment: { publicUrl: null, publicUrlMismatch: false },
    mail,
    capabilities: { graphMail: { appConfigured: false, defaultTenantId: null } },
    disclaimer: { acceptedVersion: null, acceptedAt: null, currentVersion: "1" },
    updatedAt: null,
  };
}

const ownStored = settings({
  transport: "graph",
  graph: {
    sender: "alerts@contoso.com",
    tenantId: TENANT,
    app: "own",
    ownApp: { clientId: CLIENT_ID, credentialKind: "secret", credentialStored: true },
  },
});

const googleStored = settings({
  transport: "google",
  google: {
    sender: "alerts@example.com",
    serviceAccountEmail: "notify@p.iam.gserviceaccount.com",
    clientId: "112233445566778899",
    keyStored: true,
  },
});

const KEY = JSON.stringify({
  type: "service_account",
  client_email: "notify@p.iam.gserviceaccount.com",
  client_id: "112233445566778899",
  private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
});

function issues(values: MailFormValues, from: InstallationSettings): string[] {
  const result = mailFormSchema(mailFormContext(from)).safeParse(values);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`);
}

function graphValues(overrides: Partial<MailFormValues["graph"]> = {}): MailFormValues {
  const values = mailFormFromSettings(ownStored.mail);
  return { ...values, graph: { ...values.graph, ...overrides } };
}

describe("own app registration", () => {
  it("starts from the stored public facts, never a secret", () => {
    expect(mailFormFromSettings(ownStored.mail).graph).toEqual({
      app: "own",
      sender: "alerts@contoso.com",
      tenantId: TENANT,
      clientId: CLIENT_ID,
      credentialKind: "secret",
      clientSecret: "",
      certificatePem: "",
    });
  });

  it("keeps the stored secret only for the same tenant, app and credential kind", () => {
    const stored = mailFormContext(ownStored).storedGraphOwn;
    expect(mayKeepGraphCredential(graphValues().graph, stored)).toBe(true);
    expect(
      mayKeepGraphCredential(graphValues({ clientId: CLIENT_ID.toUpperCase() }).graph, stored),
    ).toBe(true);
    expect(
      mayKeepGraphCredential(graphValues({ credentialKind: "certificate" }).graph, stored),
    ).toBe(false);
    expect(
      mayKeepGraphCredential(
        graphValues({ tenantId: "22222222-2222-3333-4444-555555555555" }).graph,
        stored,
      ),
    ).toBe(false);
    expect(issues(graphValues(), ownStored)).toEqual([]);
    expect(issues(graphValues({ credentialKind: "certificate" }), ownStored)).toEqual([
      "graph.certificatePem:credentialRequired",
    ]);
  });

  it("needs a directory ID, an application ID and the secret value", () => {
    const fresh = settings({ transport: null });
    expect(
      issues(
        graphValues({
          tenantId: "contoso.onmicrosoft.com",
          clientId: "nope",
          clientSecret: "0f0e0d0c-0b0a-0908-0706-050403020100",
        }),
        fresh,
      ),
    ).toEqual([
      "graph.tenantId:tenantGuid",
      "graph.clientId:guid",
      "graph.clientSecret:secretIsId",
    ]);
    expect(issues(graphValues({ tenantId: "", clientId: "" }), fresh)).toEqual([
      "graph.tenantId:required",
      "graph.clientId:required",
      "graph.clientSecret:credentialRequired",
    ]);
  });

  it("explains its reasons with the texts of Installation, Microsoft 365", () => {
    expect(fieldMessageKey({ type: "custom", message: "secretIsId" })).toBe(
      "settings:microsoftApp.validation.secretIsId",
    );
    expect(fieldMessageKey({ type: "custom", message: "tenantGuid" })).toBe(
      "settings:validation.tenantGuid",
    );
    expect(fieldMessageKey({ type: "custom", message: "serviceAccountKey" })).toBe(
      "settings:validation.serviceAccountKey",
    );
  });

  it("sends the secret only when one was typed", () => {
    expect(toMailInput({ ...graphValues(), transport: "graph" })).toEqual({
      transport: "graph",
      graph: {
        sender: "alerts@contoso.com",
        tenantId: TENANT,
        app: "own",
        ownApp: { clientId: CLIENT_ID, credentialKind: "secret" },
      },
    });
    expect(
      toMailInput({ ...graphValues({ clientSecret: " s3cr3t " }), transport: "graph" }),
    ).toMatchObject({ graph: { ownApp: { clientSecret: "s3cr3t" } } });
    expect(
      toMailInput({
        ...graphValues({ credentialKind: "certificate", certificatePem: "PEM", clientSecret: "x" }),
        transport: "graph",
      }),
    ).toMatchObject({
      graph: { ownApp: { credentialKind: "certificate", certificatePem: "PEM" } },
    });
  });
});

describe("Google Workspace", () => {
  function googleValues(overrides: Partial<MailFormValues["google"]> = {}): MailFormValues {
    const values = mailFormFromSettings(googleStored.mail);
    return { ...values, google: { ...values.google, ...overrides } };
  }

  it("keeps the stored key, needs one otherwise, and checks a pasted one", () => {
    expect(issues(googleValues(), googleStored)).toEqual([]);
    const fresh = settings({ transport: null });
    expect(issues(googleValues(), fresh)).toEqual(["google.serviceAccountKey:required"]);
    expect(issues(googleValues({ serviceAccountKey: "{}" }), fresh)).toEqual([
      "google.serviceAccountKey:serviceAccountKey",
    ]);
    expect(issues(googleValues({ serviceAccountKey: KEY, sender: "x" }), fresh)).toEqual([
      "google.sender:email",
    ]);
  });

  it("reads only the public facts of a pasted key", () => {
    expect(previewServiceAccountKey(KEY)).toEqual({
      clientEmail: "notify@p.iam.gserviceaccount.com",
      clientId: "112233445566778899",
    });
    expect(previewServiceAccountKey("not json")).toBeNull();
    expect(
      previewServiceAccountKey(JSON.stringify({ ...JSON.parse(KEY), type: "authorized_user" })),
    ).toBeNull();
  });

  it("sends the key only when one was pasted", () => {
    expect(toMailInput(googleValues())).toEqual({
      transport: "google",
      google: { sender: "alerts@example.com" },
    });
    expect(toMailInput(googleValues({ serviceAccountKey: ` ${KEY} ` }))).toEqual({
      transport: "google",
      google: { sender: "alerts@example.com", serviceAccountKey: KEY },
    });
  });
});

describe("guide commands", () => {
  const placeholders = {
    clientId: "<application ID>",
    objectId: "<object ID>",
    sender: "<sender mailbox>",
    group: "<group>",
  };

  it("restrict the app to exactly the sender mailbox", () => {
    const rbac = rbacCommands({ clientId: CLIENT_ID, sender: "alerts@contoso.com", placeholders });
    expect(rbac.split("\n")).toEqual([
      "Connect-ExchangeOnline",
      `New-ServicePrincipal -AppId '${CLIENT_ID}' -ObjectId '<object ID>' -DisplayName 'Notification mail sender'`,
      `New-ManagementScope -Name 'Notification mail sender' -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'alerts@contoso.com'"`,
      `New-ManagementRoleAssignment -App '${CLIENT_ID}' -Role 'Application Mail.Send' -CustomResourceScope 'Notification mail sender'`,
      `Test-ServicePrincipalAuthorization -Identity '${CLIENT_ID}' -Resource 'alerts@contoso.com'`,
    ]);
    const policy = accessPolicyCommands({ clientId: "", sender: "", placeholders });
    expect(policy).toContain("New-ApplicationAccessPolicy -AppId '<application ID>'");
    expect(policy).toContain("-PolicyScopeGroupId '<group>' -AccessRight RestrictAccess");
    expect(policy).toContain("Test-ApplicationAccessPolicy -Identity '<sender mailbox>'");
  });

  it("quote a value as PowerShell expects", () => {
    expect(
      rbacCommands({ clientId: CLIENT_ID, sender: "o'neil@contoso.com", placeholders }),
    ).toContain("'o''neil@contoso.com'");
  });

  it("delegate nothing but gmail.send", () => {
    expect(GMAIL_SEND_SCOPE).toBe("https://www.googleapis.com/auth/gmail.send");
  });
});

describe("test failure reasons", () => {
  it("have a text for every reason, and a generic one for a reason this UI does not know", () => {
    expect(mailTestFailureKey("google_delegation_missing")).toBe(
      "mail.test.reasons.google_delegation_missing",
    );
    expect(mailTestFailureKey("something_new")).toBe("mail.test.reasons.transport_error");
  });
});
