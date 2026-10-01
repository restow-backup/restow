import { describe, expect, it } from "vitest";

import { ApiError, type ProblemDetails } from "@/lib/api";

import { invitationLink } from "./paths";
import {
  addMemberError,
  canCreateTenant,
  canEnter,
  createTenantError,
  fallbackTenant,
  filterTenants,
  genericError,
  healthDetail,
  installationUsage,
  invitationFailure,
  isCustomerNumberConflict,
  isExpired,
  isSlugConflict,
  mailTestFailureKey,
  mailboxUsage,
  memberChangeError,
  notificationTestErrorKey,
  parseTenantsSearch,
  readinessBadge,
  statusBadge,
  suggestedRole,
  tenantRoleFromMemberRole,
} from "./presenters";
import type { TenantHealth, TenantItem, UsageOverview } from "./types";

function problem(status: number, fields: Partial<ProblemDetails> = {}): ApiError {
  return new ApiError(status, { type: "about:blank", title: "Problem", status, ...fields }, "x");
}

function tenant(id: string, overrides: Partial<TenantItem> = {}): TenantItem {
  return {
    id,
    name: `Tenant ${id}`,
    slug: `tenant-${id}`,
    status: "active",
    organizationId: `org-${id}`,
    mailboxCap: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

const usage: UsageOverview = {
  usedMailboxes: 12,
  mailboxesByTenant: { a: 12 },
};

describe("creating tenants", () => {
  it("always allows the first tenant", () => {
    expect(canCreateTenant({ tenantCount: 0, additionalTenants: false })).toBe(true);
  });

  it("blocks a second tenant unless the installation enables additional tenants", () => {
    expect(canCreateTenant({ tenantCount: 1, additionalTenants: false })).toBe(false);
    expect(canCreateTenant({ tenantCount: 40, additionalTenants: true })).toBe(true);
  });
});

describe("mailbox usage", () => {
  it("states the installation usage", () => {
    expect(installationUsage(usage)).toEqual({
      key: "tenants:overview.usage",
      values: { count: 12 },
    });
  });

  it("reads a tenant's protected mailboxes against the agreed cap", () => {
    expect(mailboxUsage(tenant("a", { mailboxCap: 10 }), usage)).toEqual({
      used: 12,
      cap: 10,
      overCap: true,
    });
    expect(mailboxUsage(tenant("b"), usage)).toEqual({ used: 0, cap: null, overCap: false });
  });

  it("says unknown instead of zero when the usage could not be read", () => {
    expect(mailboxUsage(tenant("a", { mailboxCap: 10 }), undefined)).toEqual({
      used: null,
      cap: 10,
      overCap: false,
    });
  });
});

describe("badges and health", () => {
  it("shows a backup without a proven restore like a failure", () => {
    expect(readinessBadge("red").variant).toBe("destructive");
    expect(readinessBadge("yellow").variant).toBe("warning");
    expect(readinessBadge("green")).toEqual({
      variant: "success",
      labelKey: "tenants:readiness.green",
    });
    expect(readinessBadge(null)).toEqual({ variant: "muted", labelKey: "tenants:readiness.none" });
  });

  it("has a badge for every tenant status", () => {
    expect(statusBadge("active")).toEqual({
      variant: "outline",
      labelKey: "tenants:status.active",
    });
    expect(statusBadge("suspended").variant).toBe("warning");
    expect(statusBadge("deleting").variant).toBe("destructive");
  });

  it("explains the readiness in one line", () => {
    const base: TenantHealth = {
      readiness: "green",
      protectedObjects: 4,
      notReady: 0,
      lastBackupAt: null,
      lastCheckedAt: null,
    };
    expect(healthDetail({ ...base, protectedObjects: 0, readiness: null })).toEqual({
      key: "tenants:readiness.nothingProtected",
    });
    expect(healthDetail({ ...base, readiness: "red", notReady: 1 })).toEqual({
      key: "tenants:readiness.notReadyCount",
      values: { count: 1, total: 4 },
    });
    expect(healthDetail(base)).toEqual({
      key: "tenants:readiness.allReady",
      values: { count: 4 },
    });
  });
});

describe("lists", () => {
  const tenants = [
    tenant("a", { name: "Müller GmbH", slug: "mueller-gmbh" }),
    tenant("b", { name: "Example Ltd", slug: "example" }),
  ];

  it("filters by name or slug, case-insensitively", () => {
    expect(filterTenants(tenants, "MÜLLER").map((entry) => entry.id)).toEqual(["a"]);
    expect(filterTenants(tenants, "mueller").map((entry) => entry.id)).toEqual(["a"]);
    expect(filterTenants(tenants, " exam ").map((entry) => entry.id)).toEqual(["b"]);
    expect(filterTenants(tenants, "   ")).toHaveLength(2);
    expect(filterTenants(tenants, "nothing")).toEqual([]);
  });

  it("never offers a tenant being deleted to work in", () => {
    expect(canEnter(tenant("a"))).toBe(true);
    expect(canEnter(tenant("a", { status: "suspended" }))).toBe(true);
    expect(canEnter(tenant("a", { status: "deleting" }))).toBe(false);
    expect(
      fallbackTenant([tenant("a"), tenant("b", { status: "deleting" }), tenant("c")], "a")?.id,
    ).toBe("c");
    expect(fallbackTenant([tenant("a")], "a")).toBeNull();
  });

  it("recognises expired invitations", () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    expect(isExpired("2026-09-23T11:59:59.000Z", now)).toBe(true);
    expect(isExpired("2026-09-30T00:00:00.000Z", now)).toBe(false);
    expect(isExpired(null, now)).toBe(false);
    expect(isExpired("garbage", now)).toBe(false);
  });

  it("suggests an admin role until someone administers the tenant", () => {
    expect(suggestedRole(0)).toBe("tenant_admin");
    expect(suggestedRole(1)).toBe("tenant_user");
  });

  it("builds invitation links on the public URL", () => {
    expect(invitationLink("https://backup.example.org/", "abc")).toBe(
      "https://backup.example.org/invitations/abc",
    );
    expect(invitationLink("http://10.0.0.5:8080", "a b")).toBe(
      "http://10.0.0.5:8080/invitations/a%20b",
    );
  });
});

describe("API failures", () => {
  it("recognises a slug conflict from the problem type or the better-auth code", () => {
    expect(isSlugConflict(problem(409, { type: "urn:restow:problem:slug-taken" }))).toBe(true);
    expect(isSlugConflict(problem(409, { code: "ORGANIZATION_ALREADY_EXISTS" }))).toBe(true);
    expect(isSlugConflict(problem(400, { code: "ORGANIZATION_SLUG_ALREADY_TAKEN" }))).toBe(true);
    expect(isSlugConflict(problem(409))).toBe(false);
    expect(isSlugConflict(new Error("x"))).toBe(false);
  });

  it("explains a refused further tenant neutrally, whichever build refused it", () => {
    expect(
      createTenantError(
        problem(403, {
          type: "urn:restow:problem:feature-unavailable",
          feature: "tenants.additional",
        }),
      ),
    ).toEqual({ key: "tenants:errors.featureUnavailable" });
    expect(
      createTenantError(
        problem(403, {
          type: "urn:restow:problem:edition-required",
          requiredEdition: "service_provider",
          edition: "business",
        }),
      ),
    ).toEqual({ key: "tenants:errors.featureUnavailable" });
    expect(createTenantError(problem(409, { type: "urn:restow:problem:setup-required" }))).toEqual({
      key: "tenants:errors.setupRequired",
    });
    expect(createTenantError(problem(500))).toEqual({ key: "common:errors.server" });
  });

  it("tells existing members and open invitations apart", () => {
    expect(
      addMemberError(problem(409, { code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION" })),
    ).toEqual({ key: "tenants:errors.alreadyMember" });
    expect(addMemberError(problem(409, { invitationId: "i1" }))).toEqual({
      key: "tenants:errors.alreadyInvited",
    });
    expect(addMemberError(problem(422))).toEqual({ key: "common:errors.validation" });
  });

  it("maps a vanished member to its own message and everything else to the shared ones", () => {
    expect(memberChangeError(problem(404))).toEqual({ key: "tenants:errors.memberGone" });
    expect(memberChangeError(problem(403))).toEqual({ key: "common:errors.forbidden" });
    expect(genericError(new Error("offline"))).toEqual({ key: "common:errors.generic" });
  });

  it("recognises a customer number conflict and reports it on the field", () => {
    expect(
      isCustomerNumberConflict(problem(409, { type: "urn:restow:problem:customer-number-taken" })),
    ).toBe(true);
    expect(isCustomerNumberConflict(problem(409))).toBe(false);
    expect(
      createTenantError(problem(409, { type: "urn:restow:problem:customer-number-taken" })),
    ).toEqual({ key: "tenants:validation.customerNumberTaken" });
  });
});

describe("tenant wizard notifications", () => {
  it("maps every test-mail failure reason to its own message", () => {
    expect(mailTestFailureKey("timeout")).toBe(
      "tenants:wizard.notifications.testMail.testFailure.timeout",
    );
    expect(mailTestFailureKey("graph_app_missing")).toBe(
      "tenants:wizard.notifications.testMail.testFailure.graphAppMissing",
    );
    expect(mailTestFailureKey("graph_tenant_missing")).toBe(
      "tenants:wizard.notifications.testMail.testFailure.graphTenantMissing",
    );
    expect(mailTestFailureKey("transport_error")).toBe(
      "tenants:wizard.notifications.testMail.testFailure.transportError",
    );
  });

  it("explains why the test mail could not even be sent (thrown errors, not a failed attempt)", () => {
    expect(
      notificationTestErrorKey(problem(409, { type: "urn:restow:problem:mail-not-configured" })),
    ).toEqual({ key: "tenants:wizard.notifications.testMail.notConfigured" });
    expect(notificationTestErrorKey(problem(403))).toEqual({ key: "common:errors.forbidden" });
    expect(notificationTestErrorKey(problem(500))).toEqual({ key: "common:errors.server" });
    expect(notificationTestErrorKey(new Error("offline"))).toEqual({
      key: "common:errors.generic",
    });
  });
});

describe("tenants list URL state", () => {
  it("opens the wizard only for new=1 and drops everything else", () => {
    expect(parseTenantsSearch({ new: "1" })).toEqual({ new: true });
    expect(parseTenantsSearch({})).toEqual({});
    expect(parseTenantsSearch({ new: "0" })).toEqual({});
    expect(parseTenantsSearch({ other: "1" })).toEqual({});
    expect(parseTenantsSearch(undefined)).toEqual({});
  });
});

describe("invitations", () => {
  it("classifies better-auth failures", () => {
    expect(
      invitationFailure({ status: 400, code: "INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION" }),
    ).toBe("detailsHidden");
    expect(
      invitationFailure({ status: 403, code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION" }),
    ).toBe("wrongRecipient");
    expect(invitationFailure({ status: 400, code: "INVITATION_NOT_FOUND" })).toBe("invalid");
    expect(invitationFailure({ status: 400 })).toBe("invalid");
    expect(
      invitationFailure({ status: 403, code: "EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION" }),
    ).toBe("emailUnverified");
    expect(invitationFailure({ status: 500 })).toBe("failed");
  });

  it("maps organization roles onto tenant roles", () => {
    expect(tenantRoleFromMemberRole("owner")).toBe("tenant_admin");
    expect(tenantRoleFromMemberRole("member,admin")).toBe("tenant_admin");
    expect(tenantRoleFromMemberRole("member")).toBe("tenant_user");
    expect(tenantRoleFromMemberRole(null)).toBe("tenant_user");
  });
});
