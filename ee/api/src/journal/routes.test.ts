import type { Database } from "@restow/db";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  registerApiExtension,
  resetExtensionsForTesting,
} from "../../../../apps/api/src/extensions.js";
import { OWNER_ACCESS, type ProviderAccess } from "../../../../apps/api/src/lib/provider-access.js";
import {
  PROVIDER_ROLE_PROBLEM,
  type SessionEnv,
  type SessionVariables,
  type TenantEnv,
  assertProviderRoute,
} from "../../../../apps/api/src/middleware/session.js";
import { errorHandler } from "../../../../apps/api/src/problem.js";
import { eeProviderRouteRules } from "../provider-rules.js";
import { JOURNAL_PATH, buildJournalRoutes } from "./routes.js";

vi.mock("./setup.js", () => ({
  getJournalReceiver: vi.fn(async () => ({ state: "listening" })),
  getJournalSetup: vi.fn(async () => ({ address: "journal+abc234@archive.example.test" })),
  rotateJournalAddress: vi.fn(async () => ({ address: "journal+xyz789@archive.example.test" })),
}));

/**
 * The journal setup routes under the provider team's rules
 * (apps/api/src/lib/provider-access.ts): the address is a credential, so a
 * technician or a read-only member gets neither the address nor a rotation.
 * The stand-in for `requireTenant` runs the same `assertProviderRoute` check,
 * against the route the real router matched.
 */
const TENANT = "11111111-1111-4111-8111-111111111111";

function appFor(access: ProviderAccess): Hono {
  const requireAdmin: MiddlewareHandler<TenantEnv> = async (c, next) => {
    assertProviderRoute(c, {
      isProviderAdmin: true,
      providerAccess: access,
    } as unknown as SessionVariables);
    c.set("tenantId", TENANT);
    c.set("user", { id: "user-1", email: "admin@provider.test" } as never);
    await next();
  };
  // The same check for the installation-level route: no tenant, the rule of the matched route.
  const requireProvider: MiddlewareHandler<SessionEnv> = async (c, next) => {
    assertProviderRoute(
      c as never,
      {
        isProviderAdmin: true,
        providerAccess: access,
      } as unknown as SessionVariables,
    );
    await next();
  };
  const app = new Hono();
  app.onError(errorHandler);
  app.route(
    `/api/v1${JOURNAL_PATH}`,
    buildJournalRoutes({
      db: {} as Database,
      providerDb: {} as Database,
      requireAdmin,
      requireProvider,
      environment: () => ({
        journal: {
          port: 2525,
          hostname: "archive.example.test",
          tlsCertPath: undefined,
          tlsKeyPath: undefined,
          maxSizeBytes: 1024,
        },
        docsTroubleshootingUrl: "https://docs.example.test/troubleshooting/",
      }),
    }),
  );
  return app;
}

const access = (role: ProviderAccess["role"], tenants?: string[]): ProviderAccess => ({
  role,
  allTenants: tenants === undefined,
  tenantIds: new Set(tenants ?? []),
});

const REQUESTS = [
  { method: "GET", path: `/api/v1${JOURNAL_PATH}` },
  { method: "POST", path: `/api/v1${JOURNAL_PATH}/rotate` },
] as const;

// The provider team's rules for these routes come from ee/ (../provider-rules.ts).
registerApiExtension({ name: "ee-provider-rules", providerRouteRules: eeProviderRouteRules });

afterAll(() => {
  resetExtensionsForTesting();
});

describe("journal routes and the provider team", () => {
  it.each(REQUESTS)("lets an owner and an administrator $method $path", async (request) => {
    for (const member of [
      OWNER_ACCESS,
      access("administrator"),
      access("administrator", [TENANT]),
    ]) {
      const response = await appFor(member).request(request.path, { method: request.method });
      expect(response.status, `${member.role}`).toBe(200);
    }
  });

  it.each(REQUESTS)(
    "keeps a technician and a read-only member off $method $path",
    async (request) => {
      for (const role of ["technician", "read_only"] as const) {
        const response = await appFor(access(role)).request(request.path, {
          method: request.method,
        });
        expect(response.status, role).toBe(403);
        const body = (await response.json()) as {
          type: string;
          requiredProviderRole?: string;
          reason?: string;
        };
        expect(body.type).toBe(PROVIDER_ROLE_PROBLEM);
        expect(body.reason).toBe("role");
        expect(body.requiredProviderRole).toBe("administrator");
      }
    },
  );
});

describe("the receiver route and the provider team", () => {
  const path = `/api/v1${JOURNAL_PATH}/receiver`;

  it("shows the receiver to every role that has every tenant", async () => {
    for (const role of ["owner", "administrator", "technician", "read_only"] as const) {
      const response = await appFor(access(role)).request(path);
      expect(response.status, role).toBe(200);
      expect(await response.json()).toEqual({ state: "listening" });
    }
  });

  it("keeps a member limited to some tenants off it: the receiver concerns all of them", async () => {
    for (const role of ["administrator", "read_only"] as const) {
      const response = await appFor(access(role, [TENANT])).request(path);
      expect(response.status, role).toBe(403);
      const body = (await response.json()) as { type: string; reason?: string };
      expect(body.type).toBe(PROVIDER_ROLE_PROBLEM);
      expect(body.reason).toBe("scope");
    }
  });
});
