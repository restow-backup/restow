import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertDatabaseRoles,
  authLoginFromEnvironment,
  authUrlFromEnvironment,
  DatabaseRoleError,
  type DatabaseRoleInfo,
  deriveAuthLogin,
  describeRoleProblems,
  type Queryable,
  roleLoginFromUrl,
  roleProblems,
  scramSha256Verifier,
  scramVerifierMatches,
  TABLE_ACCESS,
} from "./roles.js";

const appRole: DatabaseRoleInfo = {
  name: "restow_app",
  superuser: false,
  bypassRls: false,
  ownsTables: false,
};

describe("roleProblems", () => {
  it("accepts an application role that is subject to Row Level Security", () => {
    expect(roleProblems("tenant", appRole)).toEqual([]);
  });

  it("names everything that lets the tenant role get around the policies", () => {
    expect(
      roleProblems("tenant", {
        name: "restow",
        superuser: true,
        bypassRls: true,
        ownsTables: true,
      }),
    ).toEqual(["superuser", "bypass_rls", "owns_tables"]);
  });

  it("requires the installation role to bypass Row Level Security", () => {
    expect(roleProblems("installation", appRole)).toEqual(["no_bypass_rls"]);
    expect(roleProblems("installation", { ...appRole, bypassRls: true })).toEqual([]);
  });

  it("tells the operator which variable to change", () => {
    const message = describeRoleProblems(
      "tenant",
      { ...appRole, name: "restow", superuser: true },
      ["superuser"],
    );
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain('"restow"');
    expect(message).toContain("superuser");
  });
});

function poolAs(role: DatabaseRoleInfo): Queryable {
  return {
    async query<R>() {
      return {
        rows: [
          {
            name: role.name,
            superuser: role.superuser,
            bypass_rls: role.bypassRls,
            owns_tables: role.ownsTables,
          },
        ] as R[],
      };
    },
  };
}

describe("assertDatabaseRoles", () => {
  const provider: DatabaseRoleInfo = { ...appRole, name: "restow_provider", bypassRls: true };

  it("passes two correctly separated roles", async () => {
    await expect(
      assertDatabaseRoles({ tenant: poolAs(appRole), installation: poolAs(provider) }),
    ).resolves.toEqual({ tenant: appRole, installation: provider });
  });

  it("refuses a superuser application pool, the way every compose default used to run", async () => {
    const owner = { name: "restow", superuser: true, bypassRls: true, ownsTables: true };
    await expect(
      assertDatabaseRoles({ tenant: poolAs(owner), installation: poolAs(provider) }),
    ).rejects.toThrow(DatabaseRoleError);
  });

  it("refuses one role for both pools", async () => {
    await expect(
      assertDatabaseRoles({ tenant: poolAs(provider), installation: poolAs(provider) }),
    ).rejects.toThrow(/different roles|BYPASSRLS/);
  });

  const authRole: DatabaseRoleInfo = { ...appRole, name: "restow_app_auth" };

  it("checks the auth pool like the application pool", async () => {
    await expect(
      assertDatabaseRoles({
        tenant: poolAs(appRole),
        installation: poolAs(provider),
        auth: poolAs(authRole),
      }),
    ).resolves.toEqual({ tenant: appRole, installation: provider, auth: authRole });
    await expect(
      assertDatabaseRoles({
        tenant: poolAs(appRole),
        installation: poolAs(provider),
        auth: poolAs({ ...authRole, bypassRls: true }),
      }),
    ).rejects.toThrow(/DATABASE_AUTH_URL connects as "restow_app_auth", which has BYPASSRLS/);
  });

  it("refuses an auth pool that shares a role with another pool", async () => {
    await expect(
      assertDatabaseRoles({
        tenant: poolAs(appRole),
        installation: poolAs(provider),
        auth: poolAs(appRole),
      }),
    ).rejects.toThrow(/DATABASE_URL and DATABASE_AUTH_URL both connect as "restow_app"/);
  });
});

describe("the auth role's login", () => {
  const tenant = { name: "restow_app", password: "app-secret" };
  const installation = { name: "restow_provider", password: "provider-secret" };

  it("is named after the application role and keyed with the installation password", () => {
    const login = deriveAuthLogin(tenant, installation);
    expect(login.name).toBe("restow_app_auth");
    expect(login.password).toBe(
      createHmac("sha256", "provider-secret")
        .update("restow/database-auth-role/v1:restow_app_auth")
        .digest("base64url"),
    );
    // Deterministic: the migration step and the api arrive at the same login.
    expect(deriveAuthLogin(tenant, installation)).toEqual(login);
    // A new installation password gives a new one; the application password plays no part.
    expect(deriveAuthLogin(tenant, { ...installation, password: "other" }).password).not.toBe(
      login.password,
    );
    expect(deriveAuthLogin({ ...tenant, password: "other" }, installation)).toEqual(login);
  });

  it("stays a valid role name for the longest application role name", () => {
    const long = deriveAuthLogin({ name: "a".repeat(63), password: "x" }, installation);
    expect(long.name).toBe(`${"a".repeat(58)}_auth`);
    expect(long.name).toHaveLength(63);
  });

  it("comes from DATABASE_AUTH_URL when set, else from the other two URLs", () => {
    const env = {
      DATABASE_URL: "postgres://restow_app:app-secret@postgres:5432/restow?sslmode=disable",
      DATABASE_PROVIDER_URL: "postgres://restow_provider:provider-secret@postgres:5432/restow",
    };
    const derived = deriveAuthLogin(tenant, installation);
    expect(authLoginFromEnvironment(env)).toEqual(derived);
    const url = new URL(authUrlFromEnvironment(env));
    expect(roleLoginFromUrl(url.toString(), "x")).toEqual(derived);
    expect(`${url.host}${url.pathname}${url.search}`).toBe("postgres:5432/restow?sslmode=disable");

    const explicit = "postgres://restow_auth:own-secret@db:5432/restow";
    expect(authUrlFromEnvironment({ ...env, DATABASE_AUTH_URL: ` ${explicit} ` })).toBe(explicit);
    expect(authLoginFromEnvironment({ ...env, DATABASE_AUTH_URL: explicit })).toEqual({
      name: "restow_auth",
      password: "own-secret",
    });
    expect(authLoginFromEnvironment({ ...env, DATABASE_AUTH_URL: "" })).toEqual(derived);
    expect(() => authLoginFromEnvironment({ DATABASE_URL: env.DATABASE_URL })).toThrow(
      /DATABASE_AUTH_URL/,
    );
  });
});

describe("TABLE_ACCESS", () => {
  it("keeps the credential tables away from the application role", () => {
    for (const table of ["session", "account", "two_factor", "passkey", "verification"]) {
      expect(TABLE_ACCESS[table], table).toBe("auth");
    }
    for (const table of [
      "settings",
      "license",
      "providers",
      "service_heartbeats",
      "restart_requests",
    ]) {
      expect(TABLE_ACCESS[table], table).toBe("installation");
    }
  });
});

describe("roleLoginFromUrl", () => {
  it("reads the role and its password from a connection string", () => {
    expect(
      roleLoginFromUrl("postgres://restow_app:p%40ss%3Aword@postgres:5432/restow", "DATABASE_URL"),
    ).toEqual({ name: "restow_app", password: "p@ss:word" });
  });

  it("refuses logins it cannot provision safely", () => {
    expect(() => roleLoginFromUrl("not a url", "DATABASE_URL")).toThrow(DatabaseRoleError);
    expect(() => roleLoginFromUrl("postgres://restow_app@postgres/restow", "DATABASE_URL")).toThrow(
      /password/,
    );
    expect(() =>
      roleLoginFromUrl('postgres://Evil";DROP:x@postgres/restow', "DATABASE_URL"),
    ).toThrow(/lower case/);
  });
});

describe("scramSha256Verifier", () => {
  // RFC 7677 section 3: user "user", password "pencil".
  const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
  const authMessage =
    "n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";

  it("produces the stored and server keys of the RFC 7677 exchange", () => {
    const verifier = scramSha256Verifier("pencil", { salt, iterations: 4096 });
    const [, keys = ""] = verifier.split("$").slice(1);
    const [storedKey = "", serverKey = ""] = keys.split(":");
    const serverSignature = createHmac("sha256", Buffer.from(serverKey, "base64"))
      .update(authMessage)
      .digest("base64");
    expect(serverSignature).toBe("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");

    // ClientProof = ClientKey XOR HMAC(StoredKey, AuthMessage); StoredKey = H(ClientKey).
    const proof = Buffer.from("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=", "base64");
    const signature = createHmac("sha256", Buffer.from(storedKey, "base64"))
      .update(authMessage)
      .digest();
    const clientKey = Buffer.from(proof.map((byte, index) => byte ^ (signature[index] ?? 0)));
    expect(createHash("sha256").update(clientKey).digest("base64")).toBe(storedKey);
    expect(verifier.startsWith("SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$")).toBe(true);
  });

  it("recognises a verifier made from the same password", () => {
    const verifier = scramSha256Verifier("correct horse");
    expect(scramVerifierMatches("correct horse", verifier)).toBe(true);
    expect(scramVerifierMatches("battery staple", verifier)).toBe(false);
    expect(scramVerifierMatches("correct horse", null)).toBe(false);
    expect(scramVerifierMatches("correct horse", "md5abcdef")).toBe(false);
  });

  it("salts every verifier", () => {
    expect(scramSha256Verifier("same")).not.toBe(scramSha256Verifier("same"));
  });
});
