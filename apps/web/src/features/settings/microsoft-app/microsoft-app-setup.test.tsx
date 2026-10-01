import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import type { AppTestResult, MicrosoftAppView } from "./api";
import { TestOutcome } from "./app-test";
import { MicrosoftAppGuide } from "./microsoft-app-setup";

/**
 * The guide rendered to static markup (no DOM needed): what an admin sees for
 * a registration saved in Restow, one from the server environment and none at
 * all, and how a failed connection test reads. Router links become plain
 * anchors so the guide renders outside a router.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ className, children }: { className?: string; children: React.ReactNode }) => (
      <a href="/settings" className={className}>
        {children}
      </a>
    ),
  };
});

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";

const PERMISSIONS: MicrosoftAppView["permissions"] = [
  { permission: "Mail.ReadWrite", type: "application", required: true, purpose: "mail" },
  { permission: "Files.ReadWrite.All", type: "application", required: true, purpose: "onedrive" },
  { permission: "Mail.Send", type: "application", required: false, purpose: "notifications" },
  { permission: "openid", type: "delegated", required: true, purpose: "signIn" },
  { permission: "profile", type: "delegated", required: true, purpose: "signIn" },
];

function view(overrides: Partial<MicrosoftAppView> = {}): MicrosoftAppView {
  return {
    source: "database",
    clientId: CLIENT_ID,
    homeTenantId: "contoso.onmicrosoft.com",
    authorityHost: null,
    credential: { kind: "secret", set: true, expiresAt: null, certificate: null },
    problem: null,
    updatedAt: "2026-09-20T08:00:00.000Z",
    updatedBy: "admin@provider.test",
    redirectUris: {
      adminConsent: "https://restow.example.com/api/v1/sources/m365/consent/callback",
      signIn: "https://restow.example.com/api/auth/callback/microsoft",
    },
    permissions: PERMISSIONS,
    sso: { configured: false },
    environmentPartial: false,
    lastTest: null,
    ...overrides,
  };
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
}

/** The `<input>` element with the given id, as rendered; empty when there is none. */
function inputById(html: string, id: string): string {
  const match = [...html.matchAll(/<input[^>]*>/g)].find((entry) =>
    entry[0].includes(`id="${id}"`),
  );
  return match?.[0] ?? "";
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("MicrosoftAppGuide", () => {
  it("walks through the four steps with the exact redirect URI and the permission list", () => {
    const html = render(<MicrosoftAppGuide view={view({ source: "none", clientId: null })} />);
    expect(html).toContain("Register the app");
    expect(html).toContain("API permissions");
    expect(html).toContain("Credentials");
    expect(html).toContain("Enter in Restow");
    expect(html).toContain("App registrations");
    expect(html).toContain(
      "Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)",
    );
    expect(html).toContain(
      'value="https://restow.example.com/api/v1/sources/m365/consent/callback"',
    );
    expect(html).toContain('href="https://entra.microsoft.com/');
    expect(html).toContain('rel="noopener noreferrer"');
    for (const permission of ["Mail.ReadWrite", "Files.ReadWrite.All", "Mail.Send", "openid"]) {
      expect(html).toContain(permission);
    }
    expect(html).toContain("Mail.ReadWrite, not Mail.Read");
    expect(html).toContain("Copy the Value, not the Secret ID");
    expect(html).toContain("openssl req -x509");
    expect(html).toContain("Save the registration first");
  });

  it("never prefills the secret and says a stored one is kept", () => {
    const html = render(<MicrosoftAppGuide view={view()} />);
    const secret = inputById(html, "page-msapp-client-secret");
    expect(secret).toContain('type="password"');
    expect(secret).not.toMatch(/value="[^"]+"/);
    expect(secret).toContain('placeholder="Stored. Leave empty to keep it"');
    expect(html).toContain("A secret is stored. Leave the field empty to keep it.");
    expect(html).toContain("Remove registration");
  });

  it("shows a registration from the server environment read-only", () => {
    const html = render(
      <MicrosoftAppGuide
        view={view({ source: "environment", updatedAt: null, updatedBy: null })}
      />,
    );
    expect(html).toContain("From the server environment");
    expect(html).toContain("They take precedence and can only be changed there.");
    expect(html).toContain("there is nothing to enter here");
    expect(inputById(html, "page-msapp-client-id")).toBe("");
    expect(inputById(html, "page-msapp-client-secret")).toBe("");
    expect(html).not.toContain("Remove registration");
  });

  it("flags an expired credential in red", () => {
    const html = render(
      <MicrosoftAppGuide
        view={view({
          credential: {
            kind: "secret",
            set: true,
            expiresAt: "2020-01-01T00:00:00.000Z",
            certificate: null,
          },
        })}
      />,
    );
    expect(html).toMatch(/bg-destructive\/15[^>]*>.*Expired/);
    expect(html).toContain("Create the next credential now");
  });

  it("does not promise a sign-in for end users: that is not part of this release", () => {
    const html = render(<MicrosoftAppGuide view={view({ source: "none" })} variant="page" />);
    expect(html).not.toContain("Sign-in for end users");
    expect(html).not.toContain("Self-service restore");
  });

  it("has an inline form for the source page, without the settings-only cards", () => {
    const html = render(<MicrosoftAppGuide view={view({ source: "none" })} variant="inline" />);
    expect(html).toContain("Set up the Microsoft 365 app registration first");
    expect(html).toContain('id="inline-msapp-client-id"');
    expect(html).not.toContain("Sign-in for end users");
    expect(html).not.toContain("Remove registration");
  });
});

describe("TestOutcome", () => {
  const failed: AppTestResult = {
    ok: false,
    checkedAt: "2026-09-23T10:00:00.000Z",
    durationMs: 120,
    tenantId: "contoso.onmicrosoft.com",
    clientId: CLIENT_ID,
    source: "database",
    credentialKind: "secret",
    tokenAcquired: false,
    reason: "invalid_secret",
    aadsts: "AADSTS7000215",
    detail: "AADSTS7000215: Invalid client secret provided.",
    permissions: null,
  };

  it("explains an Entra refusal in the operator's language, with its code", async () => {
    let html = render(<TestOutcome result={failed} />);
    expect(html).toContain("Usually the Secret ID was entered instead of the Value");
    expect(html).toContain("AADSTS7000215");
    await i18n.changeLanguage("de");
    html = render(<TestOutcome result={failed} />);
    expect(html).toContain("Meist wurde die Geheime ID statt des Werts eingetragen");
    await i18n.changeLanguage("en");
  });

  it("lists the permissions and names the Mail.Read pitfall", () => {
    const html = render(
      <TestOutcome
        result={{
          ...failed,
          tokenAcquired: true,
          reason: "permissions_missing",
          aadsts: null,
          detail: null,
          permissions: {
            checks: [
              {
                permission: "Mail.ReadWrite",
                required: true,
                purpose: "mail",
                state: "read_only",
                grantedInstead: "Mail.Read",
              },
              {
                permission: "User.Read.All",
                required: true,
                purpose: "users",
                state: "granted",
                grantedInstead: null,
              },
            ],
            granted: ["User.Read.All"],
            missing: ["Mail.ReadWrite"],
            readOnlyInstead: [{ expected: "Mail.ReadWrite", granted: "Mail.Read" }],
            unexpected: [],
            complete: false,
          },
        }}
      />,
    );
    expect(html).toContain("Required permissions are missing");
    expect(html).toContain("Mail.Read was granted instead of Mail.ReadWrite");
    expect(html).toContain("Read-only");
    expect(html).toContain("Granted");
  });

  it("says so when everything is granted, without green: a connection test is not a restore check", () => {
    const html = render(
      <TestOutcome
        result={{
          ...failed,
          ok: true,
          tokenAcquired: true,
          reason: null,
          aadsts: null,
          detail: null,
          permissions: {
            checks: [
              {
                permission: "Mail.ReadWrite",
                required: true,
                purpose: "mail",
                state: "granted",
                grantedInstead: null,
              },
            ],
            granted: ["Mail.ReadWrite"],
            missing: [],
            readOnlyInstead: [],
            unexpected: [],
            complete: true,
          },
        }}
      />,
    );
    expect(html).toContain("The connection works and every required permission is granted.");
    expect(html).toContain('data-variant="info"');
    expect(html).toContain('data-tone="neutral"');
    expect(html).not.toMatch(/success/);
  });
});
