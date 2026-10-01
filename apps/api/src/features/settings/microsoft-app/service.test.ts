import { beforeAll, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../routes/v1/testing/scripted-db.js";

/**
 * With ENTRA_CLIENT_* in the server environment the registration is the
 * environment's: shown read-only, and saving or removing it here is refused
 * before the database is touched. The configuration is read on import, so the
 * environment is set first and the modules are loaded afterwards.
 */

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const ENV_SECRET = "env~secret.value_for_the_backup_app";

type Service = typeof import("./service.js");

const actor = { id: "admin-id", email: "admin@provider.test", ip: null };
const context = { observedOrigin: null };

describe("a registration from the server environment", () => {
  let service: Service;

  beforeAll(async () => {
    vi.resetModules();
    process.env.ENTRA_CLIENT_ID = CLIENT_ID;
    process.env.ENTRA_CLIENT_SECRET = ENV_SECRET;
    process.env.RESTOW_PUBLIC_URL = "https://restow.example.com";
    service = await import("./service.js");
    // process.env turns `undefined` into a string: remove the entries instead.
    for (const name of ["ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "RESTOW_PUBLIC_URL"]) {
      Reflect.deleteProperty(process.env, name);
    }
  });

  it("is shown read-only, without its secret", async () => {
    // Queries: the settings row (public URL), the last test.
    const script = scriptedDb([[], []]);
    const view = await service.getMicrosoftApp(script.db, context);
    expect(view).toMatchObject({
      source: "environment",
      clientId: CLIENT_ID,
      credential: { kind: "secret", set: true, expiresAt: null },
      updatedAt: null,
      redirectUris: {
        adminConsent: "https://restow.example.com/api/v1/sources/m365/consent/callback",
      },
    });
    expect(JSON.stringify(view)).not.toContain(ENV_SECRET);
    expect(script.pending()).toBe(0);
  });

  it("refuses saving and removing with 409, touching nothing", async () => {
    const script = scriptedDb([]);
    const save = await service
      .saveMicrosoftApp(
        script.db,
        {
          clientId: CLIENT_ID,
          clientSecret: "another",
          certificatePem: undefined,
          secretExpiresAt: null,
          homeTenantId: null,
          authorityHost: null,
        },
        actor,
        context,
      )
      .catch((error: unknown) => error);
    expect(save).toMatchObject({
      status: 409,
      type: "urn:restow:problem:microsoft-app-managed-by-environment",
    });
    const remove = await service
      .removeMicrosoftApp(script.db, actor, context)
      .catch((error: unknown) => error);
    expect(remove).toMatchObject({ status: 409 });
    expect(script.executed).toBe(0);
  });

  it("asks for the tenant to test in when none is known", async () => {
    const error = await service
      .testMicrosoftApp(scriptedDb([]).db, { tenantId: null }, actor)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 422 });
    expect((error as { extensions?: unknown }).extensions).toEqual({
      issues: [{ path: ["tenantId"], message: "required" }],
    });
  });
});
