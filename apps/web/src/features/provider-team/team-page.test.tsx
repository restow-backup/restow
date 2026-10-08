import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/api";

import type { TeamMember } from "./api";
import { teamKeys } from "./api";
import { TeamPage } from "./team-page";

/**
 * The Members page (the provider team, every edition) as each kind of
 * provider admin sees it: owners get the invite button and per-member
 * actions (a new invitation link for who has not signed in, "Reset access"
 * for an active member other than themselves), everyone else with every
 * tenant the list without them, and a member limited to some tenants a
 * notice instead of the list (the API refuses them the team as well).
 */

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn().mockResolvedValue({ items: [] }),
}));

let sessionState: Record<string, unknown> = {};
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  useSession: () => sessionState,
}));
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
  {
    userId: "u-3",
    name: "Rita Reader",
    email: "rita@provider.example",
    role: "read_only",
    allTenants: true,
    tenantIds: [],
    status: "active",
    isYou: false,
    addedAt: "2026-09-30T10:00:00.000Z",
  },
];

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function render(session: Record<string, unknown>): string {
  sessionState = {
    status: "authenticated",
    extensions: {},
    features: [],
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
    expect(html).toContain("Members");
    expect(html).toContain("Invite member");
    expect(html).toContain("Tom Tech");
    expect(html).toContain("Technician");
    expect(html).toContain("2 tenants");
    expect(html).toContain("Invited");
    expect(html).toContain("New invitation link");
    expect(html).toContain("Remove Tom Tech from the members");
  });

  it("offers Reset access for an active member, not for an invited one and not for yourself", () => {
    const html = render({ providerRole: "owner", providerAllTenants: true });
    expect(html).toContain("Reset the access of Rita Reader");
    expect(html).not.toContain("Reset the access of Tom Tech");
    expect(html).not.toContain("Reset the access of Ada Owner");
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

  it("is there without any extension or edition: several admins in every installation", () => {
    const html = render({ providerRole: "owner", providerAllTenants: true });
    expect(html).toContain("Invite member");
    expect(html).toContain("Tom Tech");
  });

  it("shows the team read-only to an administrator", () => {
    const html = render({ providerRole: "administrator", providerAllTenants: true });
    expect(html).toContain("Tom Tech");
    expect(html).toContain("Only owners can change the members.");
    expect(html).not.toContain("Invite member");
    expect(html).not.toContain("Remove Tom Tech from the members");
    expect(html).not.toContain("Reset the access of Rita Reader");
  });

  it("tells a member limited to some tenants why the team is not shown", () => {
    const html = render({ providerRole: "technician", providerAllTenants: false });
    expect(html).not.toContain("Tom Tech");
    expect(html).not.toContain("Only owners can change the members.");
    expect(html).toContain("Your role covers chosen tenants only");
  });

  it("tells someone who is no provider admin (a direct link) where their users are", () => {
    const html = render({ isProviderAdmin: false, providerRole: null });
    expect(html).not.toContain("Tom Tech");
    expect(html).toContain("Only owners and administrators of the installation see its members");
  });

  it("keeps role change and removal off your own row, with the reason", () => {
    const html = render({ providerRole: "owner", providerAllTenants: true });
    const own = /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Ada Owner[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    expect(own).toContain('data-slot="disabled-reason"');
    expect(own).toMatch(
      /aria-label="Remove Ada Owner from the members"[^>]*disabled=""|disabled=""[^>]*aria-label="Remove Ada Owner from the members"/,
    );
    const other = /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Rita Reader[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    expect(other).not.toContain('data-slot="disabled-reason"');
  });

  it("writes the role description out instead of hiding it in a title", () => {
    const html = render({ providerRole: "owner", providerAllTenants: true });
    expect(html).toContain("Sees status and reports. No content, no changes.");
    expect(html).not.toContain("audit log");
  });

  it("lists the chosen tenants of a member in an expandable list", () => {
    const html = render({ providerRole: "owner", providerAllTenants: true });
    expect(html).toContain('data-slot="member-tenants"');
    expect(html).toContain("Contoso");
    expect(html).toContain("Fabrikam");
  });

  it("leaves the tenants column out where every member has every tenant anyway", () => {
    const original = members[1] as TeamMember;
    members[1] = { ...original, allTenants: true, tenantIds: [] };
    try {
      const html = render({ providerRole: "owner", providerAllTenants: true });
      expect(html).not.toContain(">Tenants<");
      expect(html).toContain("Who administers this installation, and with which role.");
      const scoped = render({
        providerRole: "owner",
        providerAllTenants: true,
        features: ["providerTeam.tenantScope"],
      });
      expect(scoped).toContain(">Tenants<");
    } finally {
      members[1] = original;
    }
  });
});
