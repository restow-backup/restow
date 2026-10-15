import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import type { MailTestResult } from "../api";

import "../i18n";
import { MailTestOutcome } from "./mail-section";

/**
 * The outcome of a test send rendered to static markup: the backup app that the sender's tenant
 * never consented to is explained as such, with both ways out and the admin-consent link for
 * that tenant; an own app that Microsoft does not know keeps its own explanation.
 */

const CONSENT_URL =
  "https://login.microsoftonline.com/fabrikam.onmicrosoft.com/adminconsent?client_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function failed(failure: NonNullable<MailTestResult["failure"]>): MailTestResult {
  return { ok: false, transport: "graph", recipient: "ops@contoso.com", durationMs: 300, failure };
}

async function render(result: MailTestResult, language: "en" | "de" = "en"): Promise<string> {
  await i18n.changeLanguage(language);
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <MailTestOutcome result={result} />
    </I18nextProvider>,
  );
}

/** The text of the markup with the tags removed and the entities React writes decoded. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("MailTestOutcome", () => {
  const notConsented = failed({
    reason: "graph_backup_app_not_consented",
    detail: "AADSTS700016: Application with identifier 'x' was not found in the directory.",
    adminConsentUrl: CONSENT_URL,
  });

  it("explains the backup app without consent in the sender's tenant, with the consent link", async () => {
    const html = await render(notConsented);
    const text = textOf(html);
    expect(text).toContain(
      "The backup app registration is not set up in the sender mailbox's tenant: it has no admin consent there.",
    );
    expect(text).toContain(
      "register an own app in that tenant with only the application permission Mail.Send",
    );
    expect(text).toContain("Mail.Send then applies to every mailbox of that tenant");
    expect(text).not.toContain("Check the application ID");
    const link = /<a[^>]*data-slot="admin-consent-link"[^>]*>/.exec(html)?.[0] ?? "";
    expect(link).toContain(`href="${CONSENT_URL.replace(/&/g, "&amp;")}"`);
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(text).toContain("Open the admin consent for the backup app in this tenant");
    expect(text).toContain("AADSTS700016");
  });

  it("says the same in German", async () => {
    const text = textOf(await render(notConsented, "de"));
    expect(text).toContain(
      "Die App-Registrierung der Sicherung ist im Tenant des Absenderpostfachs nicht eingerichtet: Ihr fehlt dort die Administratorzustimmung.",
    );
    expect(text).toContain(
      "Registrieren Sie in diesem Tenant eine eigene App nur mit der Anwendungsberechtigung Mail.Send",
    );
    expect(text).toContain("Mail.Send gilt dann für jedes Postfach dieses Tenants");
    expect(text).toContain(
      "Administratorzustimmung für die App der Sicherung in diesem Tenant öffnen",
    );
  });

  it("keeps the explanation of an own app Microsoft does not know, without a link", async () => {
    const html = await render(
      failed({ reason: "graph_app_not_found", detail: "AADSTS700016: Application not found." }),
    );
    expect(textOf(html)).toContain(
      "This application ID does not exist in the tenant, or the app is disabled. Check the application ID and directory ID.",
    );
    expect(html).not.toContain("admin-consent-link");
  });
});
