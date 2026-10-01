import { describe, expect, it } from "vitest";
import { REQUIRED_PERMISSIONS, diffPermissions } from "../entra/permissions.js";
import type { ConnectionVerification } from "../entra/verify.js";
import { causeOfVerification } from "./verification.js";

const OK_PERMISSIONS = diffPermissions([...REQUIRED_PERMISSIONS]);

function verification(overrides: Partial<ConnectionVerification>): ConnectionVerification {
  return {
    checkedAt: "2026-09-29T10:00:00.000Z",
    tokenAcquired: true,
    tokenError: null,
    permissions: OK_PERMISSIONS,
    testCall: { ok: true, usersSampled: 3, sample: [] },
    ok: false,
    ...overrides,
  };
}

describe("causeOfVerification", () => {
  it("is null for a green verification", () => {
    expect(causeOfVerification(verification({ ok: true }))).toBeNull();
  });

  it("maps a refused token onto the cause the operator can act on", () => {
    const token = (hint: string, aadsts: string) =>
      verification({
        tokenAcquired: false,
        permissions: null,
        testCall: null,
        tokenError: {
          hint: hint as never,
          code: "invalid_client",
          aadsts,
          status: 401,
          message: `Token request failed with 401: ${aadsts}: client_secret=hunter2hunter2`,
        },
      });
    expect(causeOfVerification(token("consent_missing", "AADSTS700016"))?.code).toBe(
      "graph.consent_missing",
    );
    const expired = causeOfVerification(token("credentials_expired", "AADSTS7000222"));
    expect(expired).toMatchObject({
      code: "graph.app_credentials_invalid",
      params: { reason: "secret_expired" },
    });
    expect(causeOfVerification(token("invalid_credentials", "AADSTS7000215"))?.params.reason).toBe(
      "invalid_secret",
    );
    expect(causeOfVerification(token("tenant_unknown", "AADSTS90002"))?.code).toBe(
      "graph.tenant_not_found",
    );
    expect(causeOfVerification(token("unknown", "AADSTS1"))?.code).toBe("graph.token_rejected");
    expect(JSON.stringify(expired)).not.toContain("hunter2hunter2");
  });

  it("names the missing permissions, and the read-only variant granted instead", () => {
    const partial = diffPermissions(
      REQUIRED_PERMISSIONS.filter((name) => name !== "Mail.ReadWrite").concat("Mail.Read"),
    );
    const cause = causeOfVerification(verification({ permissions: partial }));
    expect(cause).toMatchObject({ code: "graph.permission_missing" });
    expect(cause?.params.permission).toContain("Mail.ReadWrite");
    expect(cause?.params.grantedInstead).toBe("Mail.Read");
  });

  it("classifies a failed test call like any Graph answer", () => {
    const cause = causeOfVerification(
      verification({
        testCall: {
          ok: false,
          status: 403,
          code: "Authorization_RequestDenied",
          message: "Insufficient privileges",
        },
      }),
    );
    expect(cause).toMatchObject({
      code: "graph.permission_missing",
      params: { permission: "User.Read.All" },
    });
  });
});
