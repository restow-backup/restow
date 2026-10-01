import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n.js";
import { ArchivePage } from "./archive-page.js";

/**
 * Smoke coverage for the archive page's three access states (no tenant,
 * forbidden for a non-admin, and the normal search view), rendered to
 * static markup — the same pattern as features/directory's panel tests.
 */

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 }),
}));

let sessionState: {
  status: string;
  activeTenant: { id: string; role: string } | null;
  isProviderAdmin: boolean;
} = {
  status: "authenticated",
  activeTenant: { id: "t-1", role: "tenant_admin" },
  isProviderAdmin: false,
};

vi.mock("@/lib/session", () => ({
  useSession: () => sessionState,
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function renderPage(): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <ArchivePage />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("ArchivePage", () => {
  it("shows an empty state when no tenant is active", () => {
    sessionState = {
      status: "authenticated",
      activeTenant: null,
      isProviderAdmin: false,
    };
    const html = renderPage();
    expect(html).toContain("Select a tenant");
  });

  it("shows a forbidden message for a plain tenant user", () => {
    sessionState = {
      status: "authenticated",
      activeTenant: { id: "t-1", role: "tenant_user" },
      isProviderAdmin: false,
    };
    const html = renderPage();
    expect(html).toContain("tenant administrator");
  });

  it("renders the search field and chain verification section for a tenant admin", () => {
    sessionState = {
      status: "authenticated",
      activeTenant: { id: "t-1", role: "tenant_admin" },
      isProviderAdmin: false,
    };
    const html = renderPage();
    expect(html).toContain("Search subject, sender, recipients and body");
    expect(html).toContain("Verify chain");
  });

  it("renders no legal hold section of its own (ee/web fills the archive.sections slot)", () => {
    sessionState = {
      status: "authenticated",
      activeTenant: { id: "t-1", role: "tenant_admin" },
      isProviderAdmin: false,
    };
    const html = renderPage();
    expect(html).not.toContain("Legal holds");
  });
});
