import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, organization, twoFactor } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import {
  AUTH_RATE_LIMIT,
  INVITATION_AUDIT_ACTIONS,
  guardAuthSurface,
  invitationAnswer,
  isExposedAuthEndpoint,
} from "./auth-surface.js";

describe("isExposedAuthEndpoint", () => {
  it("closes every admin endpoint, impersonation included", () => {
    for (const path of [
      "/admin/impersonate-user",
      "/admin/stop-impersonating",
      "/admin/set-user-password",
      "/admin/set-role",
      "/admin/create-user",
      "/admin/remove-user",
      "/admin/ban-user",
      "/admin/list-users",
    ]) {
      expect(isExposedAuthEndpoint(path)).toBe(false);
    }
  });

  it("keeps only the invitee's side of an invitation and the active tenant", () => {
    for (const path of [
      "/organization/get-invitation",
      "/organization/accept-invitation",
      "/organization/reject-invitation",
      "/organization/set-active",
    ]) {
      expect(isExposedAuthEndpoint(path)).toBe(true);
    }
    for (const path of [
      "/organization/list-members",
      "/organization/get-full-organization",
      "/organization/list-invitations",
      "/organization/invite-member",
      "/organization/update-member-role",
      "/organization/remove-member",
      "/organization/cancel-invitation",
      "/organization/delete",
      "/organization/update",
      "/organization/leave",
    ]) {
      expect(isExposedAuthEndpoint(path)).toBe(false);
    }
  });

  it("leaves sign-in, session, passkey and two-factor endpoints alone", () => {
    for (const path of [
      "/get-session",
      "/sign-in/email",
      "/sign-in/social",
      "/sign-out",
      "/passkey/verify-authentication",
      "/two-factor/verify-totp",
      "/callback/:id",
    ]) {
      expect(isExposedAuthEndpoint(path)).toBe(true);
    }
  });
});

describe("invitationAnswer", () => {
  const invitation = {
    id: "inv-1",
    organizationId: "org-1",
    email: "anna@contoso.test",
    role: "member",
  };

  it("reads an accepted invitation", () => {
    expect(
      invitationAnswer("/organization/accept-invitation", {
        invitation: { ...invitation, status: "accepted" },
        member: { id: "m-1" },
      }),
    ).toEqual({
      action: INVITATION_AUDIT_ACTIONS.accepted,
      invitationId: "inv-1",
      organizationId: "org-1",
      email: "anna@contoso.test",
      memberRole: "member",
    });
  });

  it("reads a declined invitation", () => {
    expect(
      invitationAnswer("/organization/reject-invitation", {
        invitation: { ...invitation, role: null, status: "rejected" },
        member: null,
      }),
    ).toMatchObject({ action: INVITATION_AUDIT_ACTIONS.declined, memberRole: null });
  });

  it("ignores failed calls and other endpoints", () => {
    expect(invitationAnswer("/organization/accept-invitation", new Error("forbidden"))).toBeNull();
    expect(invitationAnswer("/organization/accept-invitation", null)).toBeNull();
    expect(
      invitationAnswer("/organization/accept-invitation", {
        invitation: { ...invitation, status: "pending" },
      }),
    ).toBeNull();
    expect(
      invitationAnswer("/organization/get-invitation", {
        invitation: { ...invitation, status: "accepted" },
      }),
    ).toBeNull();
  });
});

/**
 * A real better-auth instance on the in-memory adapter, wired like the Restow
 * one (auth.ts) for everything this module decides: which endpoints HTTP
 * reaches, and the rate limits that hold whatever NODE_ENV says.
 */
function testAuth() {
  const tables = ["user", "session", "account", "verification", "twoFactor"] as const;
  const organizationTables = ["organization", "member", "invitation"] as const;
  return betterAuth({
    baseURL: "http://localhost:3000",
    basePath: "/api/auth",
    secret: "test-secret-that-is-long-enough-for-better-auth",
    logger: { disabled: true },
    database: memoryAdapter(
      Object.fromEntries([...tables, ...organizationTables].map((table) => [table, []])),
    ),
    emailAndPassword: { enabled: true, disableSignUp: true },
    rateLimit: AUTH_RATE_LIMIT,
    hooks: { before: guardAuthSurface },
    plugins: [organization({ allowUserToCreateOrganization: false }), admin(), twoFactor()],
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-forwarded-for": "203.0.113.9",
    },
    body: JSON.stringify(body),
  });
}

describe("the HTTP surface of a better-auth instance", () => {
  it("answers closed endpoints with 404 before any session check", async () => {
    const auth = testAuth();
    const impersonate = await auth.handler(post("/admin/impersonate-user", { userId: "u-1" }));
    expect(impersonate.status).toBe(404);
    const members = await auth.handler(
      new Request("http://localhost:3000/api/auth/organization/list-members?organizationId=o-1", {
        headers: { "x-forwarded-for": "203.0.113.9" },
      }),
    );
    expect(members.status).toBe(404);
  });

  it("still serves the open endpoints, which then ask for a session", async () => {
    const auth = testAuth();
    const accept = await auth.handler(
      post("/organization/accept-invitation", { invitationId: "inv-1" }),
    );
    expect(accept.status).toBe(401);
  });

  it("lets direct server-side calls through the guard", async () => {
    const auth = testAuth();
    // No request: the guard passes, and the endpoint's own session check answers.
    await expect(auth.api.listUsers({ query: {} })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("limits password sign-ins per client even outside production", async () => {
    expect(process.env.NODE_ENV).not.toBe("production");
    const auth = testAuth();
    const attempt = () =>
      auth.handler(
        post("/sign-in/email", { email: "nobody@example.test", password: "wrong-password" }),
      );
    const allowed = AUTH_RATE_LIMIT.customRules["/sign-in/email"].max;
    for (let i = 0; i < allowed; i += 1) {
      expect((await attempt()).status).not.toBe(429);
    }
    expect((await attempt()).status).toBe(429);
  });

  it("limits second-factor attempts per client", async () => {
    const auth = testAuth();
    const attempt = () => auth.handler(post("/two-factor/verify-totp", { code: "000000" }));
    const allowed = AUTH_RATE_LIMIT.customRules["/two-factor/*"].max;
    for (let i = 0; i < allowed; i += 1) {
      expect((await attempt()).status).not.toBe(429);
    }
    expect((await attempt()).status).toBe(429);
  });
});
