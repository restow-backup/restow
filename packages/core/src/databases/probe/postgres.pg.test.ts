/**
 * The server executor's probe against a real PostgreSQL 16 (docs/DATABASES.md 3): the engine is
 * recognised from the address alone, the session is encrypted whenever the server offers TLS, the
 * sign-in speaks SCRAM-SHA-256, and the rights matrix follows the roles the user really has.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a role that may create roles;
 * skipped otherwise. The roles it creates are dropped at the end.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbProbeSpec } from "../facts.js";
import { dbHealthIdentityOf, judgeDbHealth } from "../health.js";
import { dbInstanceIdentityOf, dbInstanceKey } from "../identity.js";
import { evaluateDbRights } from "../rights.js";
import { DbConn } from "./conn.js";
import { checkDatabaseHealthFromServer } from "./health-check.js";
import { PG_SSL_REQUEST, pgQuery, pgSignIn, pgTerminate } from "./postgres.js";
import { probeDatabaseFromServer } from "./probe.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const ROLE = `restow_d1_probe_${suffix}`;
const PASSWORD = `pw-${randomBytes(12).toString("hex")}`;

const admin = adminUrl ? new URL(adminUrl) : null;
const host = admin?.hostname ?? "localhost";
const port = Number(admin?.port || 5432);

/** Run SQL as the test's admin over the probe's own client (core has no other PostgreSQL client). */
async function asAdmin(sql: string): Promise<(string | null)[][]> {
  if (!admin) {
    throw new Error("no database");
  }
  const conn = await DbConn.open({ host, port, timeoutMs: 5000 });
  try {
    conn.write(PG_SSL_REQUEST);
    const answer = await conn.read(1);
    if (answer[0] === 0x53) {
      await conn.startTls(null);
    }
    const session = await pgSignIn(
      conn,
      decodeURIComponent(admin.username),
      decodeURIComponent(admin.password),
      admin.pathname.slice(1) || "postgres",
    );
    const rows = await pgQuery(session, sql);
    pgTerminate(session);
    return rows;
  } finally {
    conn.close();
  }
}

function spec(overrides: Partial<DbProbeSpec> = {}): DbProbeSpec {
  return {
    probeId: "00000000-0000-4000-8000-000000000002",
    engine: null,
    host,
    port: null,
    path: null,
    database: null,
    authMethod: "password",
    user: ROLE,
    password: PASSWORD,
    allowUnencrypted: false,
    timeoutSeconds: 20,
    ...overrides,
  };
}

const loopback = { allowPrivateNetworks: true };

describe.skipIf(!adminUrl)("probe against a real PostgreSQL 16", () => {
  let systemIdentifier = "";

  beforeAll(async () => {
    await asAdmin(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'`);
    const [row] = await asAdmin("SELECT system_identifier::text FROM pg_control_system()");
    systemIdentifier = row?.[0] ?? "";
  });

  afterAll(async () => {
    if (adminUrl) {
      await asAdmin(`DROP ROLE IF EXISTS ${ROLE}`);
    }
  });

  it("recognises PostgreSQL from the host alone, over TLS, and reads its facts [DB-001]", async () => {
    const result = await probeDatabaseFromServer(spec(), loopback);
    expect(result.error).toBeNull();
    expect(result).toMatchObject({ engine: "postgresql", port: 5432, login: "ok" });
    expect(result.serverVersion).toMatch(/^1[4-9]/);
    expect(result.postgresql).toMatchObject({
      currentUser: ROLE,
      superuser: false,
      createDb: false,
      readAllData: false,
      systemIdentifier,
    });
    expect(result.postgresql?.databases.some((database) => database.name === "postgres")).toBe(
      true,
    );
    // The test server runs with ssl = on: Restow used it and kept the certificate's fingerprint.
    expect(result.tls).toMatchObject({ offered: true, used: true });
    expect(result.tls.fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const identity = dbInstanceIdentityOf(result);
    expect(identity && dbInstanceKey(identity)).toBe(`postgresql:${systemIdentifier}`);
  });

  it("shows what the user allows, and what grants the rest", async () => {
    const before = evaluateDbRights(await probeDatabaseFromServer(spec({ port }), loopback));
    expect(before?.capabilities.backup).toMatchObject({
      state: "missing",
      missing: ["pg_read_all_data"],
    });
    expect(before?.capabilities.verifyOnInstance.state).toBe("missing");
    expect(before?.grantSql).toContain("GRANT pg_read_all_data TO restow_backup;");
    expect(before?.grantSql).toContain("ALTER ROLE restow_backup CREATEDB;");

    await asAdmin(`GRANT pg_read_all_data TO ${ROLE}`);
    await asAdmin(`ALTER ROLE ${ROLE} CREATEDB`);
    const after = evaluateDbRights(await probeDatabaseFromServer(spec({ port }), loopback));
    expect(after?.capabilities.backup.state).toBe("granted");
    expect(after?.capabilities.verifyOnInstance.state).toBe("granted");
    expect(after?.capabilities.pitr.state).toBe("missing");
    expect(after?.admin).toBe(false);
  });

  it("reports a wrong password as a failed sign-in without the password or the user [DB-002]", async () => {
    const wrong = `wrong-${randomBytes(6).toString("hex")}`;
    const result = await probeDatabaseFromServer(spec({ port, password: wrong }), loopback);
    expect(result).toMatchObject({ engine: "postgresql", login: "failed" });
    expect(result.error?.code).toBe("db_login_failed");
    const text = JSON.stringify(result);
    expect(text).not.toContain(wrong);
    expect(text).not.toContain(ROLE);
  });

  it("refuses the address without an approval for private networks [DB-003]", async () => {
    const result = await probeDatabaseFromServer(spec({ host: "127.0.0.1", port }), {
      allowPrivateNetworks: false,
    });
    expect(result.error?.code).toBe("db_private_network");
    expect(result.engine).toBeNull();
  });

  it("checks the health with the confirmed certificate, sizes only when asked [DB-004]", async () => {
    const first = await probeDatabaseFromServer(spec({ port }), loopback);
    const fingerprint = first.tls.fingerprintSha256;
    const check = (tlsFingerprint: string | null, sizes = false) =>
      checkDatabaseHealthFromServer(
        {
          engine: "postgresql",
          host,
          port,
          database: null,
          user: ROLE,
          password: PASSWORD,
          allowUnencrypted: false,
          tlsFingerprint,
          sizes,
        },
        loopback,
      );
    const health = await check(fingerprint);
    expect(health).toMatchObject({ engine: "postgresql", login: "ok", error: null });
    expect(health.postgresql).toBeUndefined();
    expect(health.health).toMatchObject({ systemIdentifier, databases: null });
    expect(health.health?.connectionsUsed).toBeGreaterThanOrEqual(1);
    expect(health.health?.connectionsMax).toBeGreaterThan(0);
    expect(Date.parse(health.health?.startedAt ?? "")).toBeLessThan(Date.now());
    const identity = dbHealthIdentityOf(health);
    expect(identity && dbInstanceKey(identity)).toBe(`postgresql:${systemIdentifier}`);
    const judged = judgeDbHealth(health, {
      engine: "postgresql",
      instanceKey: `postgresql:${systemIdentifier}`,
      tlsFingerprint: fingerprint,
    });
    expect(judged).toMatchObject({ ok: true, errorCode: null, tlsFingerprint: fingerprint });

    const sized = await check(fingerprint, true);
    expect(sized.health?.databases?.some((database) => database.name === "postgres")).toBe(true);

    // Another certificate than the confirmed one: no sign-in, so the password never left.
    const other = `${"0F:".repeat(31)}0F`;
    const refused = await check(other);
    expect(refused).toMatchObject({ login: "skipped", error: { code: "db_tls_changed" } });
    expect(
      judgeDbHealth(refused, {
        engine: "postgresql",
        instanceKey: `postgresql:${systemIdentifier}`,
        tlsFingerprint: other,
      }),
    ).toMatchObject({ ok: false, errorCode: "db_tls_changed" });
  });
});
