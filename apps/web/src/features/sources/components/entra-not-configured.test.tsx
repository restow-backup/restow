import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import "../i18n";
import type { EntraAppStatus } from "../types";
import { EntraNotConfigured } from "./entra-not-configured";

/**
 * Where a Microsoft 365 source waits for the app registration: a provider
 * admin gets the guided setup right there, a tenant admin learns that the
 * service provider has to act. Rendered to static markup; router links become
 * plain anchors.
 */

const session = vi.hoisted(() => ({ isProviderAdmin: false }));

vi.mock("@/lib/session", () => ({ useSession: () => session }));
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

function render(status: EntraAppStatus): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <EntraNotConfigured status={status} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

const missingApp: EntraAppStatus = {
  configured: false,
  source: "none",
  clientId: null,
  credential: null,
  redirectUri: "https://restow.example.com/api/v1/sources/m365/consent/callback",
  reasons: ["no_client_id", "no_credential"],
};

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  session.isProviderAdmin = false;
});

describe("EntraNotConfigured", () => {
  it("tells a tenant admin that the service provider has to set it up", () => {
    const html = render(missingApp);
    expect(html).toContain(
      "Your service provider has not set up the Microsoft 365 connection yet.",
    );
    expect(html).not.toContain("ENTRA_CLIENT_ID");
  });

  it("gives a provider admin the guided setup in place", () => {
    session.isProviderAdmin = true;
    const html = render(missingApp);
    // The registration is still loading: the guide's skeleton stands in for it.
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Your service provider");
  });

  it("points a provider admin to the public URL when only that is missing", () => {
    session.isProviderAdmin = true;
    const html = render({ ...missingApp, configured: false, reasons: ["no_public_url"] });
    expect(html).toContain("Public URL missing");
    expect(html).toContain("Open the settings");
  });
});
