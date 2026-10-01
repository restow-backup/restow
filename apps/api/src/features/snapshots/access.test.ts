import { describe, expect, it } from "vitest";
import {
  type Viewer,
  canAccessObject,
  isImpersonation,
  isOwnObject,
  onBehalfOfOwner,
  seesAllObjects,
  visibleObjectsCondition,
} from "./access.js";

const user: Viewer = { role: "tenant_user", userId: "u1", email: "Anna@Example.com" };
const tenantAdmin: Viewer = { role: "tenant_admin", userId: "u2", email: "admin@example.com" };
const providerAdmin: Viewer = { role: "provider_admin", userId: "u3", email: "ops@provider.test" };

const annasMailbox = { externalId: "anna@example.com", ownerEmail: null };
const annasDrive = { externalId: "b!driveid", ownerEmail: "anna@example.com" };
const bobsMailbox = { externalId: "bob@example.com", ownerEmail: "bob@example.com" };

describe("isOwnObject", () => {
  it("matches the directory owner or the external id, case-insensitively", () => {
    expect(isOwnObject(user, annasMailbox)).toBe(true);
    expect(isOwnObject(user, annasDrive)).toBe(true);
    expect(isOwnObject(user, bobsMailbox)).toBe(false);
  });

  it("never matches an empty identity", () => {
    expect(isOwnObject({ email: "  " }, { externalId: "", ownerEmail: null })).toBe(false);
  });
});

describe("canAccessObject / seesAllObjects", () => {
  it("scopes end users to their own objects and lets admins see everything", () => {
    expect(seesAllObjects(user)).toBe(false);
    expect(seesAllObjects(tenantAdmin)).toBe(true);
    expect(seesAllObjects(providerAdmin)).toBe(true);
    expect(canAccessObject(user, bobsMailbox)).toBe(false);
    expect(canAccessObject(user, annasMailbox)).toBe(true);
    expect(canAccessObject(tenantAdmin, bobsMailbox)).toBe(true);
    expect(canAccessObject(providerAdmin, bobsMailbox)).toBe(true);
  });

  it("emits a SQL filter only for end users", () => {
    expect(visibleObjectsCondition(user)).not.toBeNull();
    expect(visibleObjectsCondition(tenantAdmin)).toBeNull();
    expect(visibleObjectsCondition(providerAdmin)).toBeNull();
  });
});

describe("isImpersonation", () => {
  it("is an impersonation whenever the object is not the actor's own", () => {
    expect(isImpersonation(tenantAdmin, bobsMailbox)).toBe(true);
    expect(isImpersonation(providerAdmin, annasMailbox)).toBe(true);
    expect(isImpersonation(user, annasMailbox)).toBe(false);
    expect(
      isImpersonation(tenantAdmin, { externalId: "admin@example.com", ownerEmail: null }),
    ).toBe(false);
  });
});

describe("onBehalfOfOwner", () => {
  it("names the owner of someone else's object and nobody for one's own", () => {
    expect(onBehalfOfOwner(tenantAdmin, bobsMailbox)).toBe("bob@example.com");
    expect(onBehalfOfOwner(providerAdmin, annasDrive)).toBe("anna@example.com");
    expect(onBehalfOfOwner(user, annasDrive)).toBeNull();
    expect(onBehalfOfOwner(user, annasMailbox)).toBeNull();
  });

  it("falls back to the external id when no directory owner is known", () => {
    expect(onBehalfOfOwner(tenantAdmin, annasMailbox)).toBe("anna@example.com");
    expect(onBehalfOfOwner(tenantAdmin, { externalId: "b!orphan", ownerEmail: null })).toBe(
      "b!orphan",
    );
  });
});
