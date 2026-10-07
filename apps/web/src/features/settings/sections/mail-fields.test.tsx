import { renderToStaticMarkup } from "react-dom/server";
import { useForm } from "react-hook-form";
import { I18nextProvider } from "react-i18next";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import type { InstallationSettings, MailSettings } from "../api";
import { type MailFormValues, mailFormFromSettings } from "../forms";

import "../i18n";
import { MailFields } from "./mail-fields";

/**
 * The notification mail form rendered to static markup (no DOM needed): the
 * Microsoft 365 transport with its own app registration and the guide, the
 * backup app offered only when it exists, and Google Workspace with the
 * delegation values to copy. Secrets are never part of what is rendered.
 */

const CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TENANT = "11111111-2222-3333-4444-555555555555";

function settings(
  mail: MailSettings,
  graphMail: InstallationSettings["capabilities"]["graphMail"] = {
    appConfigured: false,
    defaultTenantId: null,
  },
): InstallationSettings {
  return {
    operatingMode: "local",
    publicUrl: null,
    passkeyReady: { ready: false, reasons: ["mode_not_public"], rpId: null, origin: null },
    environment: { publicUrl: null, publicUrlMismatch: false },
    mail,
    capabilities: { graphMail },
    disclaimer: { acceptedVersion: null, acceptedAt: null, currentVersion: "1" },
    updatedAt: null,
  };
}

function Harness({
  value,
  overrides,
}: {
  value: InstallationSettings;
  overrides: (values: MailFormValues) => MailFormValues;
}) {
  const form = useForm<MailFormValues>({
    defaultValues: overrides(mailFormFromSettings(value.mail)),
  });
  return <MailFields form={form} settings={value} />;
}

function render(
  value: InstallationSettings,
  overrides: (values: MailFormValues) => MailFormValues = (values) => values,
): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Harness value={value} overrides={overrides} />
    </I18nextProvider>,
  );
}

/** The backup app's radio button as rendered (radix renders a button with role radio). */
function backupRadio(html: string): string {
  return /<button[^>]*id="settings-graph-app-backup"[^>]*>/.exec(html)?.[0] ?? "";
}

const ownApp: MailSettings = {
  transport: "graph",
  graph: {
    sender: "alerts@contoso.com",
    tenantId: TENANT,
    app: "own",
    ownApp: { clientId: CLIENT_ID, credentialKind: "secret", credentialStored: true },
  },
};

const google: MailSettings = {
  transport: "google",
  google: {
    sender: "alerts@example.com",
    serviceAccountEmail: "notify@project.iam.gserviceaccount.com",
    clientId: "112233445566778899",
    keyStored: true,
  },
};

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("Microsoft 365", () => {
  it("starts with an own app registration and walks through the guide", () => {
    const html = render(settings({ transport: null }), (values) => ({
      ...values,
      transport: "graph",
      graph: { ...values.graph, sender: "alerts@contoso.com", clientId: CLIENT_ID },
    }));
    expect(html).toContain("Own app registration for notifications (recommended)");
    expect(html).toContain("Guide: own app registration in Microsoft Entra");
    expect(html).toContain("Accounts in this organizational directory only");
    expect(html).toContain("Mail.Send");
    expect(html).toContain("Grant admin consent for &lt;your organization&gt;");
    expect(html).toContain("not the Secret ID");
    // The restriction commands carry what the form already holds.
    expect(html).toContain(
      `New-ManagementRoleAssignment -App &#x27;${CLIENT_ID}&#x27; -Role &#x27;Application Mail.Send&#x27;`,
    );
    expect(html).toContain("PrimarySmtpAddress -eq &#x27;alerts@contoso.com&#x27;");
    expect(html).toContain("New-ApplicationAccessPolicy");
    expect(html).toContain("Copy commands");
    expect(html).toContain("Directory (tenant) ID");
    expect(html).toContain("Application (client) ID");
  });

  it("offers the backup app only when it exists, and says why not", () => {
    const html = render(settings({ transport: null }), (values) => ({
      ...values,
      transport: "graph",
    }));
    expect(backupRadio(html)).toContain(`disabled=""`);
    expect(html).toContain('data-slot="disabled-reason"');
    expect(html).toContain("No backup app registration is set up");

    const available = render(
      settings({ transport: null }, { appConfigured: true, defaultTenantId: null }),
      (values) => ({ ...values, transport: "graph" }),
    );
    expect(backupRadio(available)).not.toBe("");
    expect(backupRadio(available)).not.toContain(`disabled=""`);
    expect(available).toContain("applies to every mailbox of its tenant");
  });

  it("keeps the stored secret without showing it and folds the guide away", () => {
    const html = render(settings(ownApp));
    expect(html).toContain("A client secret is stored. Leave empty to keep it");
    expect(html).not.toContain("Client secret (value)</label><input");
    expect(html).toContain("Show guide");
    expect(html).not.toContain("Accounts in this organizational directory only");
  });
});

describe("Google Workspace", () => {
  it("shows the client ID and the one scope to delegate, and keeps the stored key", () => {
    const html = render(settings(google));
    expect(html).toContain("Service account key (JSON)");
    expect(html).toContain("A key for notify@project.iam.gserviceaccount.com is stored");
    expect(html).toContain("Show guide");

    const guide = render(settings({ transport: null }), (values) => ({
      ...values,
      transport: "google",
    }));
    expect(guide).toContain("Guide: service account in Google Workspace");
    expect(guide).toContain('value="https://www.googleapis.com/auth/gmail.send"');
    expect(guide).toContain("Manage Domain Wide Delegation");
    expect(guide).toContain("The client ID appears here once you have pasted the key below");
  });

  it("reads the client ID from a pasted key", () => {
    const key = JSON.stringify({
      type: "service_account",
      client_email: "notify@project.iam.gserviceaccount.com",
      client_id: "998877665544332211",
      private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
    });
    const html = render(settings({ transport: null }), (values) => ({
      ...values,
      transport: "google",
      google: { sender: "alerts@example.com", serviceAccountKey: key },
    }));
    expect(html).toContain('value="998877665544332211"');
    expect(html).toContain("Recognized: service account notify@project.iam.gserviceaccount.com");
  });

  it("speaks German formally", async () => {
    await i18n.changeLanguage("de");
    try {
      const html = render(settings(google));
      expect(html).toContain(
        "Ein Schlüssel für notify@project.iam.gserviceaccount.com ist gespeichert",
      );
      expect(html).toContain("Anleitung anzeigen");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
