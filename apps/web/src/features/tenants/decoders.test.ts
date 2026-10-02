import { describe, expect, it } from "vitest";

import {
  decodeAddMemberResult,
  decodeContactList,
  decodeInvitationDetails,
  decodeMemberList,
  decodeRecipientList,
  decodeTenantCustomer,
  decodeTenantDetail,
  decodeTenantHealth,
  decodeTenantList,
  decodeUsageOverview,
} from "./decoders";

/** Fixtures in the shape of the API DTOs (apps/api/src/features/*). */

const tenantDto = {
  id: "0b6c3a55-7c0e-4a55-9c55-3f7c1d0e0001",
  name: "Example Ltd",
  slug: "example-ltd",
  kind: "customer",
  status: "active",
  customerNumber: "K-1001",
  organizationId: "org-1",
  mailboxCap: 50,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-02T08:00:00.000Z",
};

describe("decodeTenantList", () => {
  it("reads the paged shape and maps the mailbox cap", () => {
    const [tenant] = decodeTenantList({ items: [tenantDto] });
    expect(tenant).toEqual({
      id: tenantDto.id,
      name: "Example Ltd",
      slug: "example-ltd",
      kind: "customer",
      status: "active",
      customerNumber: "K-1001",
      organizationId: "org-1",
      mailboxCap: 50,
      createdAt: tenantDto.createdAt,
      updatedAt: tenantDto.updatedAt,
    });
  });

  it("reads the own organisation, and a server from before it existed as customers", () => {
    const tenants = decodeTenantList({
      items: [
        { ...tenantDto, kind: "internal", customerNumber: null },
        { ...tenantDto, id: "b", kind: undefined, customerNumber: undefined },
        { ...tenantDto, id: "c", kind: "reseller", customerNumber: "" },
      ],
    });
    expect(tenants.map((tenant) => [tenant.kind, tenant.customerNumber])).toEqual([
      ["internal", null],
      ["customer", null],
      ["customer", null],
    ]);
  });

  it("accepts a bare array, drops rows without id and defaults unknown values", () => {
    const tenants = decodeTenantList([
      { ...tenantDto, status: "archived", mailboxCap: null, organizationId: null },
      { name: "no id" },
    ]);
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.status).toBe("active");
    expect(tenants[0]?.mailboxCap).toBeNull();
    expect(tenants[0]?.organizationId).toBeNull();
  });

  it("returns nothing for payloads that are not lists", () => {
    expect(decodeTenantList(null)).toEqual([]);
    expect(decodeTenantList({ items: "nope" })).toEqual([]);
  });
});

describe("decodeTenantDetail", () => {
  it("adds counts and the key version", () => {
    const detail = decodeTenantDetail({
      ...tenantDto,
      status: "deleting",
      memberCount: 3,
      pendingInvitations: 1,
      keyVersion: 2,
    });
    expect(detail.status).toBe("deleting");
    expect(detail.memberCount).toBe(3);
    expect(detail.pendingInvitations).toBe(1);
    expect(detail.keyVersion).toBe(2);
  });

  it("treats missing counts as zero and a missing key as none", () => {
    const detail = decodeTenantDetail(tenantDto);
    expect(detail.memberCount).toBe(0);
    expect(detail.keyVersion).toBeNull();
  });

  it("decodes customer data, contacts and notification recipients", () => {
    const detail = decodeTenantDetail({
      ...tenantDto,
      customer: { customerNumber: "K-1", countryCode: "DE", language: "de" },
      contacts: [
        { id: "c1", name: "Alice", role: "IT", email: "a@b.co", phone: null, isPrimary: true },
        { id: "" }, // dropped: no id
      ],
      notificationRecipients: [
        { id: "r1", email: "ops@b.co", name: null, categories: ["jobFailures", "bogus"] },
      ],
    });
    expect(detail.customer).toMatchObject({ customerNumber: "K-1", countryCode: "DE" });
    expect(detail.contacts).toHaveLength(1);
    expect(detail.contacts[0]).toMatchObject({ id: "c1", name: "Alice", isPrimary: true });
    expect(detail.notificationRecipients).toEqual([
      { id: "r1", email: "ops@b.co", name: null, categories: ["jobFailures"] },
    ]);
  });

  it("defaults customer data to nulls and lists to empty without a response", () => {
    const detail = decodeTenantDetail(tenantDto);
    expect(detail.customer).toEqual({
      customerNumber: null,
      vatId: null,
      addressLine1: null,
      addressLine2: null,
      postalCode: null,
      city: null,
      countryCode: null,
      language: null,
      timeZone: null,
    });
    expect(detail.contacts).toEqual([]);
    expect(detail.notificationRecipients).toEqual([]);
  });
});

describe("decodeTenantCustomer / decodeContactList / decodeRecipientList", () => {
  it("decode the bare-object and bare-array responses of the edit endpoints", () => {
    expect(decodeTenantCustomer({ customerNumber: "K-9" })).toMatchObject({
      customerNumber: "K-9",
    });
    const contacts = decodeContactList([
      { id: "c1", name: "Alice", isPrimary: true },
      { id: "c2", name: "Bob", isPrimary: false },
    ]);
    expect(contacts.map((contact) => contact.name)).toEqual(["Alice", "Bob"]);
    const recipients = decodeRecipientList([
      { id: "r1", email: "a@b.co", categories: ["weeklyReport"] },
    ]);
    expect(recipients[0]?.categories).toEqual(["weeklyReport"]);
  });

  it("return an empty list for a malformed payload", () => {
    expect(decodeContactList(null)).toEqual([]);
    expect(decodeRecipientList({ not: "an array" })).toEqual([]);
  });
});

describe("decodeMemberList", () => {
  it("maps members and keeps only pending invitations", () => {
    const list = decodeMemberList({
      members: [
        {
          userId: "u1",
          name: "Ada",
          email: "ada@example.org",
          role: "tenant_admin",
          memberRole: "owner",
          joinedAt: "2026-09-03T10:00:00.000Z",
        },
        { userId: "u2", name: "", email: "bob@example.org", role: "something" },
      ],
      invitations: [
        {
          id: "i1",
          email: "carol@example.org",
          role: "tenant_user",
          status: "pending",
          expiresAt: "2026-09-10T10:00:00.000Z",
          createdAt: "2026-09-03T10:00:00.000Z",
        },
        { id: "i2", email: "dave@example.org", role: "tenant_user", status: "canceled" },
      ],
    });
    expect(list.members.map((member) => [member.userId, member.role])).toEqual([
      ["u1", "tenant_admin"],
      ["u2", "tenant_user"],
    ]);
    expect(list.invitations.map((invitation) => invitation.id)).toEqual(["i1"]);
    expect(list.invitations[0]?.expiresAt).toBe("2026-09-10T10:00:00.000Z");
  });

  it("is empty for a tenant without organization", () => {
    expect(decodeMemberList({ members: [], invitations: [] })).toEqual({
      members: [],
      invitations: [],
    });
    expect(decodeMemberList(undefined)).toEqual({ members: [], invitations: [] });
  });
});

describe("decodeAddMemberResult", () => {
  it("distinguishes a direct membership from an invitation", () => {
    expect(
      decodeAddMemberResult({
        status: "member",
        userId: "u1",
        email: "ada@example.org",
        role: "tenant_admin",
      }),
    ).toEqual({ status: "member", userId: "u1", email: "ada@example.org", role: "tenant_admin" });
    expect(
      decodeAddMemberResult({
        status: "invited",
        invitationId: "i1",
        email: "new@example.org",
        role: "tenant_user",
        expiresAt: "2026-09-30T00:00:00.000Z",
      }),
    ).toEqual({
      status: "invited",
      invitationId: "i1",
      email: "new@example.org",
      role: "tenant_user",
      expiresAt: "2026-09-30T00:00:00.000Z",
    });
  });
});

describe("decodeTenantHealth", () => {
  const object = (latestSnapshotAt: string | null) => ({
    object: { id: "o", kind: "mailbox", displayName: null, externalId: "x", status: "active" },
    state: "green",
    latestSnapshotAt,
  });

  it("condenses the readiness overview of a tenant", () => {
    const health = decodeTenantHealth({
      summary: {
        total: 5,
        green: 2,
        yellow: 0,
        red: 1,
        unverified: 1,
        noBackup: 1,
        overdue: 0,
        overall: "red",
        lastCheckedAt: "2026-09-20T02:00:00.000Z",
        running: 0,
      },
      objects: [
        object("2026-09-21T01:00:00.000Z"),
        object("2026-09-22T01:00:00.000Z"),
        object(null),
        object("not a date"),
      ],
    });
    expect(health).toEqual({
      readiness: "red",
      protectedObjects: 5,
      notReady: 3,
      lastBackupAt: "2026-09-22T01:00:00.000Z",
      lastCheckedAt: "2026-09-20T02:00:00.000Z",
    });
  });

  it("reports nothing protected when the tenant has no objects", () => {
    expect(decodeTenantHealth({ summary: { total: 0, overall: null }, objects: [] })).toEqual({
      readiness: null,
      protectedObjects: 0,
      notReady: 0,
      lastBackupAt: null,
      lastCheckedAt: null,
    });
  });
});

describe("decodeUsageOverview", () => {
  it("reads the installation's mailboxes and the mailboxes per tenant", () => {
    const usage = decodeUsageOverview({
      mailboxes: 42,
      tenants: [
        { id: "t1", name: "A", slug: "a", status: "active", mailboxes: 40, cap: null },
        { id: "t2", name: "B", slug: "b", status: "active", mailboxes: 2, cap: 5 },
      ],
    });
    expect(usage).toEqual({
      usedMailboxes: 42,
      mailboxesByTenant: { t1: 40, t2: 2 },
    });
  });

  it("tolerates a partial payload", () => {
    expect(decodeUsageOverview({})).toEqual({ usedMailboxes: 0, mailboxesByTenant: {} });
    expect(decodeUsageOverview({ mailboxes: -3, tenants: [{ mailboxes: 4 }] })).toEqual({
      usedMailboxes: 0,
      mailboxesByTenant: {},
    });
  });
});

describe("decodeInvitationDetails", () => {
  it("maps the organization onto the tenant and the organization role onto the tenant role", () => {
    const details = decodeInvitationDetails({
      id: "i1",
      email: "ada@example.org",
      role: "admin",
      organizationId: "org-1",
      inviterId: "u9",
      status: "pending",
      expiresAt: new Date("2026-09-30T00:00:00.000Z"),
      organizationName: "Example Ltd",
      organizationSlug: "example-ltd",
      inviterEmail: "admin@example.org",
    });
    expect(details).toEqual({
      id: "i1",
      email: "ada@example.org",
      role: "tenant_admin",
      tenantName: "Example Ltd",
      tenantSlug: "example-ltd",
      inviterEmail: "admin@example.org",
      expiresAt: "2026-09-30T00:00:00.000Z",
    });
  });

  it("treats a plain member invitation as a user invitation", () => {
    expect(decodeInvitationDetails({ id: "i2", role: "member" }).role).toBe("tenant_user");
  });
});
