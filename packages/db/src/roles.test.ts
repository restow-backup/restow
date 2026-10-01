import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DatabaseRoleError,
  type DatabaseRoleInfo,
  type Queryable,
  assertDatabaseRoles,
  describeRoleProblems,
  roleLoginFromUrl,
  roleProblems,
  scramSha256Verifier,
  scramVerifierMatches,
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
    ).rejects.toThrow(/two different roles|BYPASSRLS/);
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
