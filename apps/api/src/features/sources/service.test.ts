import type { ConnectionVerification } from "@restow/core";
import { REQUIRED_PERMISSIONS, diffPermissions } from "@restow/core";
import type { Source } from "@restow/db";
import { describe, expect, it } from "vitest";
import { consentLandingUrl } from "./routes.js";
import {
  type SourceConfigExt,
  bindingConflict,
  consentLinkTarget,
  consentingAdminLabel,
  derivedStatus,
  identityConsentError,
  isUniqueViolation,
  mayReuseStoredPassword,
  patchNeedsPassword,
  probeSummary,
  retainedDataProblem,
  statusAfterPatch,
  toDto,
  toPermissionsVerified,
  verificationSummary,
  withoutUserSample,
} from "./service.js";

const green: ConnectionVerification = {
  checkedAt: "2026-09-22T10:00:00.000Z",
  tokenAcquired: true,
  tokenError: null,
  permissions: diffPermissions([...REQUIRED_PERMISSIONS]),
  testCall: { ok: true, usersSampled: 3, sample: [] },
  ok: true,
};

const baseRow: Source = {
  id: "7d8e9f00-1111-2222-3333-444455556666",
  tenantId: "0b3f6b2e-9c2d-4c3a-9e7f-1d2c3b4a5f60",
  kind: "m365",
  name: "Contoso",
  status: "pending",
  errorMessage: null,
  failure: null,
  lastSyncAt: null,
  entraTenantId: null,
  consentGrantedAt: null,
  consentBy: null,
  permissionsVerified: null,
  host: null,
  port: null,
  security: null,
  username: null,
  secretRef: null,
  config: {},
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-02T00:00:00Z"),
};

describe("toPermissionsVerified", () => {
  it("projects the schema's column shape from a verification", () => {
    expect(toPermissionsVerified(green)).toEqual({
      checkedAt: green.checkedAt,
      granted: [...REQUIRED_PERMISSIONS],
      missing: [],
    });
    expect(toPermissionsVerified({ ...green, permissions: null })).toEqual({
      checkedAt: green.checkedAt,
      granted: [],
      missing: [],
    });
  });
});

describe("verificationSummary", () => {
  it("is null when everything is green", () => {
    expect(verificationSummary(green)).toBeNull();
  });

  it("names the token problem first", () => {
    expect(
      verificationSummary({
        ...green,
        ok: false,
        tokenAcquired: false,
        tokenError: {
          hint: "consent_missing",
          code: "unauthorized_client",
          aadsts: "AADSTS700016",
          status: 400,
          message: "x",
        },
      }),
    ).toBe("Token: consent_missing (AADSTS700016)");
  });

  it("separates read-only pitfalls from plainly missing permissions", () => {
    const roles = REQUIRED_PERMISSIONS.filter(
      (p) => p !== "Mail.ReadWrite" && p !== "Group.Read.All",
    ).concat("Mail.Read");
    const summary = verificationSummary({
      ...green,
      ok: false,
      permissions: diffPermissions(roles),
      testCall: { ok: false, status: 403, code: "Authorization_RequestDenied", message: "no" },
    });
    expect(summary).toBe(
      "Read-only: Mail.Read instead of Mail.ReadWrite; Missing: Group.Read.All; Test call failed: Authorization_RequestDenied",
    );
  });
});

describe("probeSummary", () => {
  it("is null on success and one line on failure", () => {
    expect(
      probeSummary({
        ok: true,
        checkedAt: "2026-09-22T10:00:00.000Z",
        secure: true,
        server: null,
        mailboxes: 1,
        specialUse: [],
        capabilities: [],
      }),
    ).toBeNull();
    expect(
      probeSummary({
        ok: false,
        checkedAt: "2026-09-22T10:00:00.000Z",
        reason: "dns",
        code: "ENOTFOUND",
        message: "getaddrinfo ENOTFOUND",
      }),
    ).toBe("IMAP dns (ENOTFOUND): getaddrinfo ENOTFOUND");
  });
});

describe("toDto", () => {
  it("renders a Microsoft 365 source with hint and verification from config", () => {
    const config: SourceConfigExt = {
      scope: { mode: "all", exclude: [] },
      entraTenantHint: "contoso.onmicrosoft.com",
      lastVerification: green,
      consentError: null,
    };
    const dto = toDto({
      ...baseRow,
      entraTenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      consentGrantedAt: new Date("2026-09-03T00:00:00Z"),
      permissionsVerified: toPermissionsVerified(green),
      config,
    });
    expect(dto.imap).toBeNull();
    expect(dto.m365).toEqual({
      entraTenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      entraTenantHint: "contoso.onmicrosoft.com",
      consentGrantedAt: "2026-09-03T00:00:00.000Z",
      consentBy: null,
      consentError: null,
      permissions: toPermissionsVerified(green),
      verification: green,
    });
    // The directory feature owns the scope; it is not part of this DTO.
    expect(JSON.stringify(dto)).not.toContain("exclude");
    expect(dto.createdAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("renders an IMAP source without ever exposing the secret reference's content", () => {
    const dto = toDto({
      ...baseRow,
      kind: "imap",
      host: "imap.example.com",
      port: 993,
      security: "tls",
      username: "alice",
      secretRef: "9d8e9f00-1111-2222-3333-444455556666",
      config: { authKind: "password" },
    });
    expect(dto.m365).toBeNull();
    expect(dto.imap).toEqual({
      host: "imap.example.com",
      port: 993,
      security: "tls",
      username: "alice",
      hasPassword: true,
      authKind: "password",
      lastProbe: null,
      imapAuthMode: "shared",
      masterUser: null,
    });
    expect(JSON.stringify(dto)).not.toContain("9d8e9f00");
  });

  it("renders a master-user IMAP source's login shape, never a password", () => {
    const dto = toDto({
      ...baseRow,
      kind: "imap",
      host: "imap.hoster.example",
      port: 993,
      security: "tls",
      username: "ignored",
      secretRef: "9d8e9f00-1111-2222-3333-444455556666",
      config: {
        authKind: "password",
        imapAuthMode: "master_user",
        masterUser: { username: "master", style: "sasl_authzid" },
      },
    });
    expect(dto.imap?.imapAuthMode).toBe("master_user");
    expect(dto.imap?.masterUser).toEqual({ username: "master", style: "sasl_authzid" });
    expect(JSON.stringify(dto)).not.toContain("9d8e9f00");
  });

  it("renders per_mailbox mode with no source-level password expected", () => {
    const dto = toDto({
      ...baseRow,
      kind: "imap",
      host: "imap.hoster.example",
      port: 993,
      security: "tls",
      username: "ignored",
      secretRef: null,
      config: { imapAuthMode: "per_mailbox" },
    });
    expect(dto.imap?.imapAuthMode).toBe("per_mailbox");
    expect(dto.imap?.hasPassword).toBe(false);
    expect(dto.imap?.masterUser).toBeNull();
  });
});

describe("consentLandingUrl", () => {
  const origin = "https://restow.example.com";
  const sourceId = baseRow.id;

  const tenantId = baseRow.tenantId;

  it("sends a granted consent to the source page with tenant and verification outcome", () => {
    const url = new URL(
      consentLandingUrl(origin, { kind: "granted", tenantId, sourceId, verification: green }),
    );
    expect(url.pathname).toBe(`/sources/${sourceId}`);
    expect(url.searchParams.get("consent")).toBe("granted");
    expect(url.searchParams.get("tenant")).toBe(tenantId);
    expect(url.searchParams.get("verified")).toBe("ok");
  });

  it("carries the Entra error for a denied consent", () => {
    const url = new URL(
      consentLandingUrl(origin, { kind: "denied", tenantId, sourceId, error: "access_denied" }),
    );
    expect(url.pathname).toBe(`/sources/${sourceId}`);
    expect(url.searchParams.get("consent")).toBe("denied");
    expect(url.searchParams.get("error")).toBe("access_denied");
  });

  it("names a tenant mismatch on the source page", () => {
    const url = new URL(
      consentLandingUrl(origin, {
        kind: "tenant_mismatch",
        tenantId,
        sourceId,
        entraTenantId: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
      }),
    );
    expect(url.pathname).toBe(`/sources/${sourceId}`);
    expect(url.searchParams.get("consent")).toBe("tenant_mismatch");
    // The foreign Entra tenant id is not echoed into the URL.
    expect(url.search).not.toContain("ffffffff");
  });

  it("names why the consenting admin could not be verified", () => {
    const url = new URL(
      consentLandingUrl(origin, {
        kind: "identity_not_verified",
        tenantId,
        sourceId,
        reason: "not_an_admin",
      }),
    );
    expect(url.pathname).toBe(`/sources/${sourceId}`);
    expect(url.searchParams.get("consent")).toBe("identity_not_verified");
    expect(url.searchParams.get("reason")).toBe("not_an_admin");
  });

  it("lands on the list with a reason when the state cannot be trusted", () => {
    const url = new URL(consentLandingUrl(origin, { kind: "invalid_state", reason: "expired" }));
    expect(url.pathname).toBe("/sources");
    expect(url.searchParams.get("consent")).toBe("invalid_state");
    expect(url.searchParams.get("reason")).toBe("expired");
    expect(new URL(consentLandingUrl(origin, { kind: "unknown_source" })).search).toBe(
      "?consent=unknown_source",
    );
  });
});

describe("withoutUserSample", () => {
  it("drops names and UPNs before the verification is persisted", () => {
    const sampled: ConnectionVerification = {
      ...green,
      testCall: {
        ok: true,
        usersSampled: 1,
        sample: [{ id: "u1", displayName: "Alice", userPrincipalName: "alice@contoso.com" }],
      },
    };
    const stored = withoutUserSample(sampled);
    expect(stored.testCall).toEqual({ ok: true, usersSampled: 1, sample: [] });
    expect(JSON.stringify(stored)).not.toContain("alice@contoso.com");
    // The caller's object is left intact for the immediate response.
    expect(sampled.testCall?.ok && sampled.testCall.sample).toHaveLength(1);
  });

  it("leaves failed or empty test calls untouched", () => {
    expect(withoutUserSample(green)).toBe(green);
    const failed: ConnectionVerification = {
      ...green,
      ok: false,
      testCall: { ok: false, status: 403, code: "Forbidden", message: "no" },
    };
    expect(withoutUserSample(failed)).toBe(failed);
  });
});

describe("bindingConflict", () => {
  const entraTenantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("binds a fresh source", () => {
    expect(bindingConflict({ entraTenantId: null }, entraTenantId, false)).toBeNull();
  });

  it("accepts a re-consent in the tenant the source is bound to", () => {
    expect(
      bindingConflict({ entraTenantId: entraTenantId.toUpperCase() }, entraTenantId, false),
    ).toBeNull();
  });

  it("refuses to rebind a connected source to another tenant", () => {
    expect(
      bindingConflict(
        { entraTenantId: "11111111-2222-3333-4444-555555555555" },
        entraTenantId,
        false,
      ),
    ).toBe("tenant_mismatch");
  });

  it("refuses a tenant another source of the installation already holds", () => {
    expect(bindingConflict({ entraTenantId: null }, entraTenantId, true)).toBe(
      "tenant_already_connected",
    );
  });
});

describe("isUniqueViolation", () => {
  const violation = { code: "23505", constraint: "sources_entra_tenant_uq" };

  it("recognizes the violation directly or as the cause of a wrapper", () => {
    expect(isUniqueViolation(violation, "sources_entra_tenant_uq")).toBe(true);
    expect(
      isUniqueViolation(new Error("query failed", { cause: violation }), "sources_entra_tenant_uq"),
    ).toBe(true);
  });

  it("ignores other constraints and other errors", () => {
    expect(isUniqueViolation(violation, "sources_tenant_name_uq")).toBe(false);
    expect(
      isUniqueViolation(
        { code: "23503", constraint: "sources_entra_tenant_uq" },
        "sources_entra_tenant_uq",
      ),
    ).toBe(false);
    expect(isUniqueViolation(new Error("boom"), "sources_entra_tenant_uq")).toBe(false);
    expect(isUniqueViolation(null, "sources_entra_tenant_uq")).toBe(false);
  });
});

describe("identityConsentError", () => {
  const at = "2026-09-23T10:00:00.000Z";

  it("keeps Microsoft's own message where it helps the operator", () => {
    expect(identityConsentError("sign_in_failed", "access_denied: cancelled", at)).toEqual({
      error: "sign_in_failed",
      description: "access_denied: cancelled",
      at,
    });
    expect(identityConsentError("role_check_failed", "HTTP 403: denied", at).description).toBe(
      "HTTP 403: denied",
    );
  });

  it("leaves technical details of other reasons to the audit log", () => {
    expect(identityConsentError("identity_mismatch", "tenant", at).description).toBeNull();
    expect(identityConsentError("not_an_admin", null, at).description).toBeNull();
    expect(
      identityConsentError("app_not_configured", "certificate unreadable", at).description,
    ).toBeNull();
  });
});

describe("consentingAdminLabel", () => {
  it("prefers the UPN and falls back to the object id", () => {
    expect(consentingAdminLabel({ username: "admin@contoso.com", objectId: "o" })).toBe(
      "admin@contoso.com",
    );
    expect(consentingAdminLabel({ username: null, objectId: "o" })).toBe("o");
  });
});

/** Typed access to this feature's keys inside the shared config column. */
function cfg(value: SourceConfigExt): Source["config"] {
  return value;
}

describe("derivedStatus and statusAfterPatch", () => {
  const failedProbe = {
    ok: false as const,
    checkedAt: "2026-09-22T10:00:00.000Z",
    reason: "auth" as const,
    code: null,
    message: "no",
  };

  it("never calls a source active without a green check", () => {
    expect(derivedStatus(baseRow)).toBe("pending");
    expect(derivedStatus({ ...baseRow, config: cfg({ lastVerification: green }) })).toBe("pending");
    const consented = { ...baseRow, entraTenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
    expect(derivedStatus(consented)).toBe("pending");
    expect(derivedStatus({ ...consented, config: cfg({ lastVerification: green }) })).toBe(
      "active",
    );
    expect(
      derivedStatus({ ...consented, config: cfg({ lastVerification: { ...green, ok: false } }) }),
    ).toBe("error");
    const imap = { ...baseRow, kind: "imap" as const };
    expect(derivedStatus(imap)).toBe("pending");
    expect(derivedStatus({ ...imap, config: cfg({ lastProbe: failedProbe }) })).toBe("error");
  });

  it("a per_mailbox source is active from the start: it has no login of its own to probe", () => {
    // Regression: a per_mailbox source can never earn a green source-level
    // probe, since it never runs one; leaving it "pending" until one arrives
    // blocked every mailbox forever.
    const imap = { ...baseRow, kind: "imap" as const };
    const perMailbox = { ...imap, config: cfg({ imapAuthMode: "per_mailbox" }) };
    expect(derivedStatus(perMailbox)).toBe("active");
    // Even a stale failed probe from before the mode changed does not pull it back.
    expect(
      derivedStatus({
        ...imap,
        config: cfg({ imapAuthMode: "per_mailbox", lastProbe: failedProbe }),
      }),
    ).toBe("active");
    // shared and master_user are unaffected: still earned, not assumed.
    expect(derivedStatus({ ...imap, config: cfg({ imapAuthMode: "shared" }) })).toBe("pending");
    expect(derivedStatus({ ...imap, config: cfg({ imapAuthMode: "master_user" }) })).toBe(
      "pending",
    );
  });

  it("pauses, resumes to the earned status and resets on a changed connection", () => {
    const paused = { ...baseRow, status: "disabled" as const };
    expect(statusAfterPatch({ ...baseRow, status: "active" }, "disabled", false)).toBe("disabled");
    expect(statusAfterPatch(paused, "active", false)).toBe("pending");
    expect(
      statusAfterPatch(
        {
          ...paused,
          entraTenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          config: cfg({ lastVerification: green }),
        },
        "active",
        false,
      ),
    ).toBe("active");
    // A paused source stays paused while its connection is edited.
    expect(statusAfterPatch(paused, undefined, true)).toBe("disabled");
    expect(statusAfterPatch({ ...baseRow, status: "active" }, undefined, true)).toBe("pending");
    // "active" cannot be forced onto a source with a problem.
    expect(statusAfterPatch({ ...baseRow, status: "error" }, "active", false)).toBe("error");
  });

  it("a source switching to per_mailbox skips the pending-until-tested step", () => {
    // Regression: the documented shared -> per_mailbox migration set
    // connectionChanged, which used to move the source to "pending"
    // permanently, since a per_mailbox source never runs the probe that
    // would move it back out again.
    const imap = { ...baseRow, kind: "imap" as const, status: "active" as const };
    expect(statusAfterPatch(imap, undefined, true, "per_mailbox")).toBe("active");
    // Switching to shared or master_user still needs a fresh test, as before.
    expect(statusAfterPatch(imap, undefined, true, "shared")).toBe("pending");
    expect(statusAfterPatch(imap, undefined, true, "master_user")).toBe("pending");
    // Pausing still wins over a mode change.
    expect(statusAfterPatch(imap, "disabled", true, "per_mailbox")).toBe("disabled");
  });
});

describe("stored IMAP passwords", () => {
  const stored = { host: "imap.example.com", username: "alice@example.com" };

  it("may only be reused for the same host and username", () => {
    expect(
      mayReuseStoredPassword(stored, { host: "IMAP.example.com ", username: "alice@example.com" }),
    ).toBe(true);
    expect(
      mayReuseStoredPassword(stored, { host: "evil.example.net", username: "alice@example.com" }),
    ).toBe(false);
    expect(
      mayReuseStoredPassword(stored, { host: "imap.example.com", username: "bob@example.com" }),
    ).toBe(false);
  });

  it("forces a new password when a patch moves host or username", () => {
    expect(patchNeedsPassword(stored, {})).toBe(false);
    expect(patchNeedsPassword(stored, { host: "imap.example.com" })).toBe(false);
    expect(patchNeedsPassword(stored, { host: "evil.example.net" })).toBe(true);
    expect(patchNeedsPassword(stored, { username: "bob@example.com" })).toBe(true);
    expect(patchNeedsPassword(stored, { host: "evil.example.net", password: "new" })).toBe(false);
  });
});

describe("retainedDataProblem", () => {
  it("allows deleting a source without data", () => {
    expect(retainedDataProblem({ snapshots: 0, archiveItems: 0, legalHolds: 0 })).toBeNull();
  });

  it("refuses with the counts when anything would cascade away", () => {
    const problem = retainedDataProblem({ snapshots: 3, archiveItems: 0, legalHolds: 1 });
    expect(problem?.status).toBe(409);
    expect(problem?.type).toBe("urn:restow:problem:source-has-data");
    expect(problem?.extensions).toEqual({
      retained: { snapshots: 3, archiveItems: 0, legalHolds: 1 },
    });
  });
});

describe("consentLinkTarget", () => {
  const entraTenantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("always targets the connected tenant of a connected source", () => {
    expect(consentLinkTarget(entraTenantId, "contoso.com", "fabrikam.com")).toBe(entraTenantId);
    expect(consentLinkTarget(entraTenantId, null, null)).toBe(entraTenantId);
  });

  it("uses the requested target, where null lets the admin pick", () => {
    expect(consentLinkTarget(null, "contoso.com", "fabrikam.com")).toBe("fabrikam.com");
    expect(consentLinkTarget(null, "contoso.com", null)).toBeNull();
  });

  it("falls back to the stored hint when nothing is requested", () => {
    expect(consentLinkTarget(null, "contoso.com", undefined)).toBe("contoso.com");
    expect(consentLinkTarget(null, undefined, undefined)).toBeNull();
  });
});
