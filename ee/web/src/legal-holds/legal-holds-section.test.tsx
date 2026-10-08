import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ArchivePage } from "@/features/archive/archive-page";
import { i18n } from "@/i18n";
import {
  ExtensionSlot,
  registerWebExtension,
  resetWebExtensionsForTesting,
} from "@/lib/extensions";

import { eeWebExtension } from "../index";
import { LegalHoldsSection } from "./legal-holds-section";

/**
 * The legal hold section: shown to a tenant administrator on an edition with
 * legal holds, absent otherwise, and rendered in the archive settings of the
 * tenant page once the ee/web extension is registered (slot
 * `tenant.archiveSettings`).
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    // Links render as plain anchors: this test renders without a <RouterProvider>.
    Link: ({ to, children, ...props }: { to: string; children?: React.ReactNode }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 }),
}));

let sessionState: {
  status: string;
  activeTenant: { id: string; role: string } | null;
  isProviderAdmin: boolean;
  extensions: Record<string, unknown> | null;
} = {
  status: "authenticated",
  activeTenant: { id: "t-1", role: "tenant_admin" },
  isProviderAdmin: false,
  extensions: { edition: "business" },
};

vi.mock("@/lib/session", () => ({
  useSession: () => sessionState,
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  resetWebExtensionsForTesting();
});

function render(node: React.ReactNode): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
}

function session(edition: string, role = "tenant_admin") {
  sessionState = {
    status: "authenticated",
    activeTenant: { id: "t-1", role },
    isProviderAdmin: false,
    extensions: { edition },
  };
}

describe("LegalHoldsSection", () => {
  it("offers legal holds to a tenant administrator on the Business edition", () => {
    session("business");
    const html = render(<LegalHoldsSection />);
    expect(html).toContain("Legal holds");
    expect(html).toContain("Place legal hold");
  });

  it("renders nothing on the Community edition", () => {
    session("community");
    expect(render(<LegalHoldsSection />)).toBe("");
  });

  it("renders nothing for a plain tenant user", () => {
    session("service_provider", "tenant_user");
    expect(render(<LegalHoldsSection />)).toBe("");
  });

  it("appears in the archive settings of the tenant page once the ee/web extension is registered, and not on the daily Archive page", () => {
    session("business");
    const slot = <ExtensionSlot name="tenant.archiveSettings" props={{ readOnly: false }} />;
    expect(render(slot)).not.toContain("Legal holds");
    registerWebExtension(eeWebExtension);
    expect(render(slot)).toContain("Legal holds");
    // Legal holds are a setting of the tenant: the Archive page keeps the journal and the archive itself.
    expect(render(<ArchivePage />)).not.toContain("Legal holds");
  });
});
