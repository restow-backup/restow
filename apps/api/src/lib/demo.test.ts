import { describe, expect, it } from "vitest";
import {
  DEMO_ALLOWED_ROUTES,
  DEMO_DENIED_ROUTES,
  DEMO_RESTORE_ARCHIVE_NAME,
  DEMO_RESTORE_FOLDER_NAME,
  DEMO_RESTORE_REASON,
  demoRateLimitFor,
  demoRateLimitWindowFor,
  demoRequestAllowed,
  demoSeedTokenMatches,
  isConfiguredDemoAccountEmail,
  isConfiguredDemoCredentials,
  isDemoAccountEmail,
  isDemoAllowedRoute,
  isDemoDeniedRoute,
  isSafeDemoMethod,
  pathMatchesTemplate,
  sanitizeRestoreInputForDemo,
} from "./demo.js";

const ENDPOINT_ID = "6f1c2a52-6c0b-4d3a-9d0e-3a1b2c4d5e6f";
/** A concrete URL path for a route template of the allowlist (`:id` becomes a UUID). */
const concrete = (path: string) => path.replace(/:id/g, ENDPOINT_ID);

describe("isSafeDemoMethod", () => {
  it("treats GET, HEAD and OPTIONS as reads", () => {
    expect(isSafeDemoMethod("GET")).toBe(true);
    expect(isSafeDemoMethod("head")).toBe(true);
    expect(isSafeDemoMethod("Options")).toBe(true);
  });

  it("treats every other method as a change", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isSafeDemoMethod(method)).toBe(false);
    }
  });
});

describe("pathMatchesTemplate", () => {
  it("matches an exact path and a template whose :id segment is one UUID", () => {
    expect(pathMatchesTemplate("/api/v1/jobs/backup", "/api/v1/jobs/backup")).toBe(true);
    expect(
      pathMatchesTemplate(
        "/api/v1/endpoints/:id/downloads",
        `/api/v1/endpoints/${ENDPOINT_ID}/downloads`,
      ),
    ).toBe(true);
    expect(
      pathMatchesTemplate(
        "/api/v1/endpoints/:id/downloads",
        `/api/v1/endpoints/${ENDPOINT_ID.toUpperCase()}/downloads`,
      ),
    ).toBe(true);
  });

  it("treats nothing but a UUID as the parameter", () => {
    const template = "/api/v1/endpoints/:id/downloads";
    for (const path of [
      "/api/v1/endpoints/:id/downloads",
      "/api/v1/endpoints/x/downloads",
      "/api/v1/endpoints/tokens/downloads",
      "/api/v1/endpoints/../downloads",
      `/api/v1/endpoints/${ENDPOINT_ID}/x/downloads`,
      `/api/v1/endpoints/${ENDPOINT_ID}/downloads/extra`,
      `/api/v1/endpoints/${ENDPOINT_ID}/downloads/`,
      `/api/v1/endpoints/${ENDPOINT_ID}%2f..%2fdownloads`,
      "/api/v1/endpoints//downloads",
      `/api/v1/endpoints/${ENDPOINT_ID}`,
    ]) {
      expect(pathMatchesTemplate(template, path), path).toBe(false);
    }
  });
});

describe("isDemoAllowedRoute", () => {
  it("allows exactly the public demo actions", () => {
    for (const route of DEMO_ALLOWED_ROUTES) {
      expect(isDemoAllowedRoute(route.method, concrete(route.path))).toBe(true);
      expect(isDemoAllowedRoute(route.method.toLowerCase(), concrete(route.path))).toBe(true);
    }
  });

  it("offers the ZIP download of endpoint files, and nothing else about endpoints", () => {
    expect(isDemoAllowedRoute("POST", `/api/v1/endpoints/${ENDPOINT_ID}/downloads`)).toBe(true);
    for (const [method, path] of [
      // Restoring onto the machine, a restore test, the password, enrolling and every change.
      ["POST", `/api/v1/endpoints/${ENDPOINT_ID}/tasks`],
      ["POST", `/api/v1/endpoints/${ENDPOINT_ID}/restore-test`],
      ["POST", `/api/v1/endpoints/${ENDPOINT_ID}/repository-password`],
      ["POST", `/api/v1/endpoints/${ENDPOINT_ID}/revoke`],
      ["POST", `/api/v1/endpoints/${ENDPOINT_ID}/uninstall`],
      ["PATCH", `/api/v1/endpoints/${ENDPOINT_ID}`],
      ["POST", "/api/v1/endpoints/tokens"],
      ["DELETE", `/api/v1/endpoints/tokens/${ENDPOINT_ID}`],
      // The download route allows POST only; starting it is a GET and passes as a read.
      ["PUT", `/api/v1/endpoints/${ENDPOINT_ID}/downloads`],
      ["DELETE", `/api/v1/endpoints/${ENDPOINT_ID}/downloads`],
      ["POST", `/api/v1/endpoints/${ENDPOINT_ID}/downloads/${ENDPOINT_ID}`],
    ] as const) {
      expect(isDemoAllowedRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });

  it("never allows the agent API or the restic REST backend to a visitor", () => {
    for (const [method, path] of [
      ["POST", "/agent/v1/enroll"],
      ["POST", "/agent/v1/heartbeat"],
      ["POST", "/agent/v1/runs"],
      ["POST", `/agent/v1/runs/${ENDPOINT_ID}/progress`],
      ["POST", `/agent/v1/runs/${ENDPOINT_ID}/finish`],
      ["POST", `/agent/restic/${ENDPOINT_ID}/data/ab`],
      ["PUT", `/agent/restic/${ENDPOINT_ID}/data/ab`],
      ["DELETE", `/agent/restic/${ENDPOINT_ID}/snapshots/ab`],
      ["POST", `/agent/restic/${ENDPOINT_ID}/?create=true`],
    ] as const) {
      expect(isDemoAllowedRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });

  it("refuses everything that could alter the installation or reach outside", () => {
    const denied: Array<[string, string]> = [
      // Security review finding 1: setup is bootstrap-only, never a public
      // allowlist entry, even though it is harmless once configured (409).
      ["POST", "/api/v1/setup"],
      ["POST", "/api/v1/sources"],
      ["PATCH", "/api/v1/sources/00000000-0000-0000-0000-000000000000"],
      ["DELETE", "/api/v1/sources/00000000-0000-0000-0000-000000000000"],
      ["POST", "/api/v1/sources/00000000-0000-0000-0000-000000000000/test"],
      ["PATCH", "/api/v1/settings"],
      ["POST", "/api/v1/settings/mail/test"],
      ["PUT", "/api/v1/settings/microsoft-app"],
      ["DELETE", "/api/v1/settings/microsoft-app"],
      ["POST", "/api/v1/storage/targets"],
      ["DELETE", "/api/v1/storage/targets/00000000-0000-0000-0000-000000000000"],
      ["POST", "/api/v1/webhooks"],
      ["POST", "/api/v1/webhooks/00000000-0000-0000-0000-000000000000/test"],
      ["POST", "/api/v1/api-keys"],
      ["DELETE", "/api/v1/api-keys/00000000-0000-0000-0000-000000000000"],
      ["POST", "/api/v1/extension/anything"],
      ["DELETE", "/api/v1/extension/anything"],
      ["POST", "/api/v1/tenants"],
      ["DELETE", "/api/v1/tenants/00000000-0000-0000-0000-000000000000"],
      ["POST", "/api/v1/tenants/00000000-0000-0000-0000-000000000000/members"],
      ["POST", "/api/v1/schedules"],
      ["POST", "/api/v1/schedules/recommended"],
      ["DELETE", "/api/v1/schedules/00000000-0000-0000-0000-000000000000"],
      ["POST", "/api/v1/jobs/00000000-0000-0000-0000-000000000000/cancel"],
      ["POST", "/api/v1/jobs/00000000-0000-0000-0000-000000000000/retry"],
      ["POST", "/api/v1/verify/scrub"],
      ["PUT", "/api/v1/directory/sources/00000000-0000-0000-0000-000000000000/rules"],
      ["POST", "/api/v1/directory/sources/00000000-0000-0000-0000-000000000000/accounts"],
      ["POST", "/api/auth/change-password"],
      ["POST", "/api/auth/two-factor/enable"],
      ["POST", "/api/auth/passkey/generate-register-options"],
      ["POST", "/api/auth/update-user"],
    ];
    for (const [method, path] of denied) {
      expect(isDemoAllowedRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });
});

describe("demoRateLimitWindowFor", () => {
  it("gives every allowed route its own per-IP budget (finding M1)", () => {
    for (const route of DEMO_ALLOWED_ROUTES) {
      expect(demoRateLimitWindowFor(route.method, concrete(route.path))).toEqual(route.rateLimit);
      expect(demoRateLimitWindowFor(route.method.toLowerCase(), concrete(route.path))).toEqual(
        route.rateLimit,
      );
    }
  });

  it("counts a templated route under its template, not under the visitor's choice of id", () => {
    const other = "11111111-2222-4333-8444-555555555555";
    const a = demoRateLimitFor("POST", `/api/v1/endpoints/${ENDPOINT_ID}/downloads`);
    const b = demoRateLimitFor("POST", `/api/v1/endpoints/${other}/downloads`);
    expect(a?.key).toBe("/api/v1/endpoints/:id/downloads");
    expect(b?.key).toBe(a?.key);
    expect(demoRateLimitFor("POST", "/api/v1/jobs/backup")?.key).toBe("/api/v1/jobs/backup");
    expect(demoRateLimitFor("POST", "/api/v1/sources")).toBeUndefined();
  });

  it("gives sign-in a larger budget than the cheap sign-out/switch-tenant routes", () => {
    const signIn = demoRateLimitWindowFor("POST", "/api/auth/sign-in/email");
    const signOut = demoRateLimitWindowFor("POST", "/api/auth/sign-out");
    expect(signIn?.max).toBeDefined();
    expect(signOut?.max).toBeDefined();
    expect(signIn?.max).toBeLessThan(signOut?.max as number);
  });

  it("has no budget for a route outside the allowlist", () => {
    expect(demoRateLimitWindowFor("POST", "/api/v1/sources")).toBeUndefined();
    expect(demoRateLimitWindowFor("GET", "/api/v1/sources")).toBeUndefined();
  });
});

describe("demoSeedTokenMatches", () => {
  it("accepts only the exact configured token", () => {
    expect(demoSeedTokenMatches("secret-token", "secret-token")).toBe(true);
  });

  it("refuses a wrong, missing or unconfigured token", () => {
    expect(demoSeedTokenMatches("wrong", "secret-token")).toBe(false);
    expect(demoSeedTokenMatches(undefined, "secret-token")).toBe(false);
    expect(demoSeedTokenMatches("secret-token", undefined)).toBe(false);
    expect(demoSeedTokenMatches(undefined, undefined)).toBe(false);
    expect(demoSeedTokenMatches("", "")).toBe(false);
  });
});

describe("isDemoDeniedRoute", () => {
  it("denies better-auth's session listing and revocation endpoints", () => {
    for (const path of DEMO_DENIED_ROUTES) {
      expect(isDemoDeniedRoute(path), path).toBe(true);
    }
  });

  it("leaves every other path alone", () => {
    expect(isDemoDeniedRoute("/api/auth/get-session")).toBe(false);
    expect(isDemoDeniedRoute("/api/v1/sources")).toBe(false);
  });
});

describe("demoRequestAllowed", () => {
  it("always allows reads", () => {
    expect(
      demoRequestAllowed({
        method: "GET",
        path: "/api/v1/sources",
        seedTokenHeader: undefined,
        configuredSeedToken: "token",
      }),
    ).toBe(true);
  });

  it("allows the fixed public actions without a seed token", () => {
    expect(
      demoRequestAllowed({
        method: "POST",
        path: "/api/v1/jobs/backup",
        seedTokenHeader: undefined,
        configuredSeedToken: "token",
      }),
    ).toBe(true);
  });

  it("allows the seed process's own bootstrap calls with the right token", () => {
    expect(
      demoRequestAllowed({
        method: "POST",
        path: "/api/v1/tenants",
        seedTokenHeader: "token",
        configuredSeedToken: "token",
      }),
    ).toBe(true);
  });

  it("refuses a write outside the allowlist without the seed token", () => {
    expect(
      demoRequestAllowed({
        method: "POST",
        path: "/api/v1/tenants",
        seedTokenHeader: undefined,
        configuredSeedToken: "token",
      }),
    ).toBe(false);
    expect(
      demoRequestAllowed({
        method: "POST",
        path: "/api/v1/tenants",
        seedTokenHeader: "wrong-token",
        configuredSeedToken: "token",
      }),
    ).toBe(false);
  });

  it("lets only the seed token through to the agent API and the restic backend", () => {
    const writes = [
      ["POST", "/agent/v1/enroll"],
      ["POST", "/agent/v1/heartbeat"],
      ["POST", "/agent/v1/runs"],
      ["POST", `/agent/v1/runs/${ENDPOINT_ID}/finish`],
      ["POST", `/agent/restic/${ENDPOINT_ID}/data/ab`],
      ["DELETE", `/agent/restic/${ENDPOINT_ID}/locks/ab`],
    ] as const;
    for (const [method, path] of writes) {
      const request = (seedTokenHeader: string | undefined) => ({
        method,
        path,
        seedTokenHeader,
        configuredSeedToken: "token",
      });
      expect(demoRequestAllowed(request("token")), `${method} ${path} with the token`).toBe(true);
      for (const wrong of [undefined, "", "toke", "token ", "tokens", "TOKEN", "wrong-token"]) {
        expect(demoRequestAllowed(request(wrong)), `${method} ${path} with ${wrong}`).toBe(false);
      }
      // Without a configured token (an installation that is not the demo) nothing matches.
      expect(
        demoRequestAllowed({
          method,
          path,
          seedTokenHeader: "token",
          configuredSeedToken: undefined,
        }),
      ).toBe(false);
    }
    // Reads pass the guard (the agent API's own credentials decide), as for every route.
    expect(
      demoRequestAllowed({
        method: "GET",
        path: `/agent/restic/${ENDPOINT_ID}/config`,
        seedTokenHeader: undefined,
        configuredSeedToken: "token",
      }),
    ).toBe(true);
  });

  it("denies the session-listing/revocation endpoints even with a GET or a valid seed token", () => {
    for (const path of DEMO_DENIED_ROUTES) {
      expect(
        demoRequestAllowed({
          method: "GET",
          path,
          seedTokenHeader: undefined,
          configuredSeedToken: "token",
        }),
        path,
      ).toBe(false);
      expect(
        demoRequestAllowed({
          method: "POST",
          path,
          seedTokenHeader: "token",
          configuredSeedToken: "token",
        }),
        path,
      ).toBe(false);
    }
  });
});

describe("isDemoAccountEmail", () => {
  it("recognizes the configured demo account, case-insensitively", () => {
    const demo = { enabled: true, email: "demo@example.org" };
    expect(isDemoAccountEmail("demo@example.org", demo)).toBe(true);
    expect(isDemoAccountEmail("Demo@Example.org", demo)).toBe(true);
    expect(isDemoAccountEmail(" demo@example.org ", demo)).toBe(true);
  });

  it("refuses every other account", () => {
    const demo = { enabled: true, email: "demo@example.org" };
    expect(isDemoAccountEmail("someone.else@example.org", demo)).toBe(false);
    expect(isDemoAccountEmail(null, demo)).toBe(false);
    expect(isDemoAccountEmail(undefined, demo)).toBe(false);
  });

  it("refuses everyone when demo mode is off or has no configured email", () => {
    expect(
      isDemoAccountEmail("demo@example.org", { enabled: false, email: "demo@example.org" }),
    ).toBe(false);
    expect(isDemoAccountEmail("demo@example.org", { enabled: true, email: undefined })).toBe(false);
  });
});

describe("isConfiguredDemoAccountEmail", () => {
  it("matches the configured email regardless of whether demo mode is on", () => {
    expect(isConfiguredDemoAccountEmail("demo@example.org", "demo@example.org")).toBe(true);
    expect(isConfiguredDemoAccountEmail("Demo@Example.org", "demo@example.org")).toBe(true);
  });

  it("refuses every other account, an unset email, or no configured email", () => {
    expect(isConfiguredDemoAccountEmail("someone.else@example.org", "demo@example.org")).toBe(
      false,
    );
    expect(isConfiguredDemoAccountEmail(null, "demo@example.org")).toBe(false);
    expect(isConfiguredDemoAccountEmail("demo@example.org", undefined)).toBe(false);
  });
});

describe("isConfiguredDemoCredentials", () => {
  const demo = { email: "demo@example.org", password: "correct horse battery staple" };

  it("accepts only the exact configured email and password", () => {
    expect(
      isConfiguredDemoCredentials(
        { email: "demo@example.org", password: "correct horse battery staple" },
        demo,
      ),
    ).toBe(true);
    // Email compare is case-insensitive, like sign-in; password is exact.
    expect(
      isConfiguredDemoCredentials(
        { email: "Demo@Example.org", password: "correct horse battery staple" },
        demo,
      ),
    ).toBe(true);
  });

  it("refuses a wrong password, a wrong email, or an unconfigured account", () => {
    expect(
      isConfiguredDemoCredentials({ email: "demo@example.org", password: "wrong" }, demo),
    ).toBe(false);
    expect(
      isConfiguredDemoCredentials(
        { email: "someone.else@example.org", password: "correct horse battery staple" },
        demo,
      ),
    ).toBe(false);
    expect(
      isConfiguredDemoCredentials(
        { email: "demo@example.org", password: "correct horse battery staple" },
        { email: undefined, password: undefined },
      ),
    ).toBe(false);
  });
});

describe("sanitizeRestoreInputForDemo", () => {
  it("replaces reason, restoreFolderName and archiveName with fixed text", () => {
    expect(
      sanitizeRestoreInputForDemo({
        reason: "look at my email haha",
        options: { restoreFolderName: "pwned", archiveName: "totally-not-malware" },
      }),
    ).toEqual({
      reason: DEMO_RESTORE_REASON,
      options: {
        restoreFolderName: DEMO_RESTORE_FOLDER_NAME,
        archiveName: DEMO_RESTORE_ARCHIVE_NAME,
      },
    });
  });

  it("leaves out fields the request never set, and never invents options", () => {
    expect(sanitizeRestoreInputForDemo({})).toEqual({});
    expect(sanitizeRestoreInputForDemo({ reason: "x" })).toEqual({ reason: DEMO_RESTORE_REASON });
    expect(sanitizeRestoreInputForDemo({ options: { restoreFolderName: "x" } })).toEqual({
      options: { restoreFolderName: DEMO_RESTORE_FOLDER_NAME },
    });
  });
});
