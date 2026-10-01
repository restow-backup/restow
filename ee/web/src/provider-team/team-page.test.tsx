import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/api";

import type { TeamMember } from "./api";
import { teamKeys } from "./api";
import "./i18n";
import { TeamPage } from "./team-page";

/**
 * The provider team page as each kind of provider admin sees it: owners get
 * the invite button and per-member actions, everyone else with every tenant
 * the list without them, and a member limited to some tenants a notice
 * instead of the list (the API refuses them the team as well).
 */

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn().mockResolvedValue({ items: [] }),
}));

let sessionState: Record<string, unknown> = {};
vi.mock("@/lib/session", () => ({ useSession: () => sessionState }));
vi.mock("@/components/kit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/kit")>()),
  usePageWidth: () => undefined,
}));

const members: TeamMember[] = [
  {
    userId: "u-1",
    name: "Ada Owner",
    email: "ada@provider.example",
    role: "owner",
    allTenants: true,
    tenantIds: [],
    status: "active",
    isYou: true,
    addedAt: "2026-09-01T10:00:00.000Z",
  },
  {
    userId: "u-2",
    name: "Tom Tech",
    email: "tom@provider.example",
    role: "technician",
    allTenants: false,
    tenantIds: ["t-1", "t-2"],
    status: "invited",
    isYou: false,
    addedAt: "2026-09-29T10:00:00.000Z",
  },
];

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function render(session: Record<string, unknown>): string {
  sessionState = {
    status: "authenticated",
    extensions: { edition: "service_provider" },
    isProviderAdmin: true,
    ...session,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(teamKeys.list, { items: members });
  client.setQueryData(queryKeys.tenants, [
    { id: "t-1", name: "Contoso", slug: "contoso" },
    { id: "t-2", name: "Fabrikam", slug: "fabrikam" },
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <TeamPage />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("TeamPage", () => {
  it("gives an owner the invite button and member actions", () => {
    const html = render({ providerRole: "owner", providerAllTenants: true });
    expect(html).toContain("Provider team");
    expect(html).toContain("Invite member");
    expect(html).toContain("Tom Tech");
    expect(html).toContain("Technician");
    expect(html).toContain("2 tenants");
    expect(html).toContain("Invited");
    expect(html).toContain("New invitation link");
    expect(html).toContain("Remove Tom Tech from the team");
  });

  it("shows an active member in the neutral outline, never green", () => {
    const html = render({ providerRole: "owner", providerAllTenants: true });
    // Ada is active, Tom is invited.
    const badges = html.match(/<span data-slot="badge"[^>]*>[\s\S]*?<\/span>/g) ?? [];
    const active = badges.find((badge) => badge.includes(">Active<"));
    expect(active).toBeDefined();
    expect(active).toContain('data-variant="outline"');
    expect(active).not.toContain("success");
    const invited = badges.find((badge) => badge.includes(">Invited<"));
    expect(invited).toContain('data-variant="info"');
  });

  it("is part of the Business edition as well", () => {
    const html = render({
      extensions: { edition: "business" },
      providerRole: "owner",
      providerAllTenants: true,
    });
    expect(html).toContain("Invite member");
  });

  it("stays closed on Community", () => {
    const html = render({
      extensions: { edition: "community" },
      providerRole: "owner",
      providerAllTenants: true,
    });
    expect(html).not.toContain("Invite member");
    expect(html).not.toContain("Tom Tech");
  });

  it("shows the team read-only to an administrator", () => {
    const html = render({ providerRole: "administrator", providerAllTenants: true });
    expect(html).toContain("Tom Tech");
    expect(html).toContain("Only owners can change the team.");
    expect(html).not.toContain("Invite member");
    expect(html).not.toContain("Remove Tom Tech from the team");
  });

  it("shows a member limited to some tenants a notice instead of the team", () => {
    const html = render({ providerRole: "technician", providerAllTenants: false });
    expect(html).not.toContain("Tom Tech");
    expect(html).toContain("Only owners can change the team.");
  });
});
