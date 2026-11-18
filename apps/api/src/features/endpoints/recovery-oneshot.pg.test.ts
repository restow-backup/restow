/**
 * Oneshot restores against Postgres (docs/BAREMETAL-ONESHOT.md 6, 7, 19.1), stage O2:
 *
 *   - issuing: only with RESTOW_BAREMETAL_ONESHOT, an `OS-` code redeemable for 30 minutes, the
 *     command, a session of 12 hours (4 to 48), always with release;
 *   - the exchange: only at /oneshot (a oneshot code at the ISO's /sessions, and a code of the ISO
 *     at /oneshot, answer like unknown ones), the report of the machine kept apart, the expiry
 *     moved to the end of the session, the ISO on offer and what the restore needs;
 *   - the release: refused without answers, while the machine has not shown that it can switch,
 *     and for a machine with an enrolled agent; the answers stored under `decided` only;
 *   - the key release: no credentials and no repository read before the recovery environment
 *     reported back (`booted`), and other hardware there ends the session;
 *   - the ISO through the session: the verified copy and its signed checksums, three times, never
 *     after the switch, never for another kind.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashSecret,
  normalizeOneshotCode,
  normalizeRecoveryCode,
  oneshotCodeProof,
  recoveryCodeProof,
} from "@restow/core";
import { auditLog, endpointLayouts, endpointRecoveries } from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type EndpointFixture, startFixture, testDatabaseAdminUrl } from "./testing/fixture.js";
import {
  agentRootWithIso,
  exchangeBody,
  HARDWARE,
  insertMachine,
  isoSide,
  sessionBasic,
} from "./testing/recovery.js";

const DATABASE = "restow_api_recovery_oneshot_test";
const ORIGIN = "https://restow.firma.de";
const SPKI = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const ISO_BYTES = Buffer.from("restow recovery iso for the oneshot tests\n");
const ISO_SHA256 = createHash("sha256").update(ISO_BYTES).digest("hex");

/** What the command on a fresh machine measured (docs/BAREMETAL-ONESHOT.md 10.1). */
const TARGET = {
  hostname: "fresh-01",
  interfaces: [
    {
      name: "eth0",
      mac: "96:00:01:02:03:04",
      driver: "virtio_net",
      mtu: 1500,
      dhcp4: true,
      slaac: false,
      addresses: [
        { address: "203.0.113.7", prefix: 32, dynamic: true },
        { address: "2001:db8:1::7", prefix: 64, dynamic: false },
      ],
    },
  ],
  routes: [
    { family: "inet", gateway: "172.31.1.1", dev: "eth0", onlink: true, metric: 100 },
    { family: "inet6", gateway: "fe80::1", dev: "eth0", onlink: false, metric: 1024 },
  ],
  dns: ["185.12.64.1"],
  searchDomains: [],
  cloud: { name: "hetzner", platform: "hetzner", instanceId: "12345", region: "fsn1" },
  vendor: "Hetzner",
  product: "vServer",
  consoles: ["tty0", "ttyS0,115200n8"],
  uptimeSeconds: 300,
  rescue: false,
};

const CHECKS_NOT_TRIED = {
  mode: "kexec",
  kexec: "not_tried",
  kexecError: "",
  kexecLoadDisabled: false,
  lockdown: "none",
  secureBoot: false,
  memTotalBytes: 4 * 1024 ** 3,
  memAvailableBytes: 3 * 1024 ** 3,
  inUse: [] as string[],
  warnings: [] as string[],
};

const SSH_KEYS = [
  {
    type: "ssh-ed25519",
    fingerprint: `SHA256:${"A".repeat(43)}`,
    comment: "admin@laptop",
  },
];

/** What the command holds for one exchange: the oneshot proof for an origin and its secret. */
function commandSide(code: string, origin: string) {
  const normalized = normalizeOneshotCode(code);
  if (!normalized) throw new Error(`not a oneshot code: ${code}`);
  const sessionSecret = randomBytes(32).toString("hex");
  return {
    codeProof: oneshotCodeProof(origin, normalized),
    sessionSecret,
    sessionSecretSha256: hashSecret(sessionSecret),
  };
}

function oneshotBody(
  side: { codeProof: string; sessionSecretSha256: string },
  extra: Record<string, unknown> = {},
) {
  return {
    ...exchangeBody(side),
    target: TARGET,
    checks: CHECKS_NOT_TRIED,
    sshKeys: SSH_KEYS,
    ...extra,
  };
}

describe.skipIf(!testDatabaseAdminUrl)("oneshot restores", () => {
  let fixture: EndpointFixture;
  let app: Hono;
  let codes: typeof import("./recovery-codes.js");
  let cache: typeof import("./recovery-session-cache.js");
  let restic: typeof import("./recovery-restic-route.js");
  let shared: typeof import("../../db.js");
  let appConfig: typeof import("../../config.js")["config"];
  let storeSecret: (tenantId: string, plaintext: string) => Promise<string>;
  let isoRoot = "";
  let isoDir = "";
  let ip = 1;
  const actor = () => ({
    label: "admin@contoso.example",
    userId: fixture.adminId,
    ip: "192.0.2.1",
  });
  const instance = { url: ORIGIN, configured: true };

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    isoRoot = await agentRootWithIso(true, ISO_SHA256);
    isoDir = await mkdtemp(join(tmpdir(), "restow-oneshot-iso-"));
    await writeFile(join(isoDir, "restow-recovery_0.5.0_amd64.iso"), ISO_BYTES);
    process.env.RESTOW_AGENT_DIR = isoRoot;
    shared = await import("../../db.js");
    appConfig = (await import("../../config.js")).config;
    codes = await import("./recovery-codes.js");
    cache = await import("./recovery-session-cache.js");
    restic = await import("./recovery-restic-route.js");
    const secrets = await import("../../lib/secrets.js");
    storeSecret = async (tenantId, plaintext) =>
      (await secrets.storeSecret(shared.db, { tenantId, kind: "endpoint_repository", plaintext }))
        .id;
    const { recoveryRoutes } = await import("./recovery-routes.js");
    const { requestBodyLimit } = await import("../../middleware/body-limit.js");
    const { errorHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.use("*", requestBodyLimit);
    app.route("/agent/v1/recovery", recoveryRoutes);
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
    await rm(isoRoot, { recursive: true, force: true });
    await rm(isoDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    appConfig.baremetalPreview = true;
    appConfig.baremetalOneshot = true;
    appConfig.publicTlsSpki = SPKI;
    appConfig.recoveryIsoDir = isoDir;
    appConfig.recoveryIsoStoreDir = null;
    process.env.RESTOW_AGENT_DIR = isoRoot;
    cache.forgetRecoverySession();
  });

  const machine = (options: Omit<Parameters<typeof insertMachine>[2], "tenantId"> = {}) =>
    insertMachine(fixture.db, storeSecret, { tenantId: fixture.tenantId, ...options });

  const issue = (endpointId: string, input: Record<string, unknown> = {}) =>
    codes.issueRecoveryCode(
      shared.db,
      fixture.tenantId,
      endpointId,
      { kind: "oneshot", validityHours: 12, requireApproval: true, ...input } as never,
      actor(),
      instance,
    );

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`/agent/v1/recovery${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `198.51.100.${ip++ % 250}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });

  const get = (path: string, headers: Record<string, string>) =>
    app.request(`/agent/v1/recovery${path}`, {
      headers: { "x-forwarded-for": `198.51.100.${ip++ % 250}`, ...headers },
    });

  const stored = async (id: string) =>
    (await fixture.db.select().from(endpointRecoveries).where(eq(endpointRecoveries.id, id)))[0];

  const audits = (action: string, recoveryId: string) =>
    fixture.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, action), sql`${auditLog.details}->>'recoveryId' = ${recoveryId}`),
      );

  const approve = (
    endpointId: string,
    recoveryId: string,
    answers: Record<string, unknown> | null,
  ) =>
    codes.approveRecovery(
      shared.db,
      fixture.tenantId,
      endpointId,
      recoveryId,
      actor(),
      answers as never,
    );

  const ANSWERS = {
    networkMode: "takeover",
    confirmShrink: false,
    secureBootWarningsOnly: false,
    remoteAccess: false,
  };

  /** The answers of a release with the match code the machine shows. */
  const withCode = (s: { matchCode: string }, extra: Record<string, unknown> = {}) => ({
    ...ANSWERS,
    matchCode: `${s.matchCode.slice(0, 3)} ${s.matchCode.slice(3)}`,
    ...extra,
  });

  /** Issue a oneshot code and exchange it as the command does; answers what the command holds. */
  async function session(options: { checks?: Record<string, unknown> } = {}) {
    const target = await machine();
    const issued = await issue(target.id);
    const side = commandSide(issued.code, ORIGIN);
    const response = await post(
      "/oneshot",
      oneshotBody(side, options.checks ? { checks: options.checks } : {}),
    );
    expect(response.status, await response.clone().text()).toBe(202);
    const body = (await response.json()) as {
      sessionId: string;
      status: string;
      expiresAt: string;
      matchCode: string;
      oneshot: { iso: { sha256: string } | null; needs: { passphrase: boolean; ramBytes: number } };
    };
    return {
      ...side,
      ...body,
      issued,
      endpointId: target.id,
      auth: sessionBasic(body.sessionId, side.sessionSecret),
    };
  }

  /** A session the admin released after the command reported a good test load. */
  async function released() {
    const s = await session();
    const checked = await post(
      "/sessions/current/oneshot/checks",
      { ...CHECKS_NOT_TRIED, kexec: "ok" },
      s.auth,
    );
    expect(checked.status, await checked.clone().text()).toBe(204);
    cache.forgetRecoverySession();
    await approve(s.endpointId, s.sessionId, withCode(s));
    cache.forgetRecoverySession();
    return s;
  }

  describe("issuing", () => {
    it("issues an OS- code with its command, 30 minutes to redeem and a 12 hour session", async () => {
      const target = await machine();
      const before = Date.now();
      const issued = await issue(target.id, { validityHours: undefined });
      expect(issued.code).toMatch(/^OS(?:-[0-9A-HJKMNP-TV-X]{5}){5}$/);
      expect(issued).toMatchObject({
        kind: "oneshot",
        requireApproval: true,
        sessionValidityHours: 12,
      });
      expect(issued.command).toBe(
        `curl -fsSL '${ORIGIN}/install/oneshot.sh' | RESTOW_ONESHOT_CODE='${issued.code}' sh`,
      );
      const expires = Date.parse(issued.expiresAt);
      expect(expires - before).toBeGreaterThanOrEqual(29 * 60 * 1000);
      expect(expires - before).toBeLessThanOrEqual(31 * 60 * 1000);
      const row = await stored(issued.id);
      expect(row?.kind).toBe("oneshot");
      expect(row?.oneshot).toEqual({ validityHours: 12 });
      const normalized = normalizeOneshotCode(issued.code) as string;
      // Only the hash of the oneshot proof is stored; neither the code nor the ISO's proof of it.
      expect(row?.codeHash).toBe(
        createHash("sha256").update(oneshotCodeProof(ORIGIN, normalized)).digest("hex"),
      );
      expect(JSON.stringify(row)).not.toContain(normalized);
    });

    it("refuses an instance address that is unsafe in a shell command", async () => {
      const target = await machine();
      for (const url of [
        "https://restow.firma.de'",
        "https://a$(reboot).example",
        "https://a`reboot`.example",
        "https://a;reboot.example",
      ]) {
        await expect(
          codes.issueRecoveryCode(
            shared.db,
            fixture.tenantId,
            target.id,
            { kind: "oneshot", validityHours: 12, requireApproval: true } as never,
            actor(),
            { url, configured: true },
          ),
          url,
        ).rejects.toMatchObject({ status: 503, type: "urn:restow:problem:instance-url-unsafe" });
        expect(() => codes.oneshotCommand(url, "OS-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS")).toThrow();
      }
      expect(() => codes.oneshotCommand(ORIGIN, "OS-1';reboot;'")).toThrow();
      const rows = await fixture.db
        .select()
        .from(endpointRecoveries)
        .where(eq(endpointRecoveries.endpointId, target.id));
      expect(rows).toHaveLength(0);
    });

    it("keeps the 30 minutes to redeem: no extension before the exchange, a consistent end after", async () => {
      const target = await machine();
      const issued = await issue(target.id, { validityHours: 4 });
      await expect(
        codes.extendRecoveryCode(shared.db, fixture.tenantId, target.id, issued.id, 48, actor()),
      ).rejects.toMatchObject({ status: 409 });
      expect(Date.parse((await stored(issued.id))?.expiresAt.toISOString() ?? "")).toBe(
        Date.parse(issued.expiresAt),
      );
      const response = await post("/oneshot", oneshotBody(commandSide(issued.code, ORIGIN)));
      expect(response.status).toBe(202);
      const row = await stored(issued.id);
      const issuedAt = row?.issuedAt.getTime() ?? 0;
      expect(row?.expiresAt.getTime()).toBe(issuedAt + 4 * 60 * 60 * 1000);
      // The running session can be extended, up to 48 hours after the issue.
      const extended = await codes.extendRecoveryCode(
        shared.db,
        fixture.tenantId,
        target.id,
        issued.id,
        48,
        actor(),
      );
      expect(Date.parse(extended.expiresAt)).toBe(issuedAt + 48 * 60 * 60 * 1000);
    });

    it("never ends a session before the code's own end (a code extended before this release)", async () => {
      const { oneshotClaim } = await import("./recovery-oneshot.js");
      const issuedAt = new Date("2026-11-18T10:00:00Z");
      const row = {
        issuedAt,
        expiresAt: new Date("2026-11-19T20:00:00Z"),
        oneshot: { validityHours: 4 },
      } as never;
      const report = { target: TARGET, checks: CHECKS_NOT_TRIED, sshKeys: [] } as never;
      expect(oneshotClaim(row, report, "0.5.1").expiresAt.toISOString()).toBe(
        "2026-11-19T20:00:00.000Z",
      );
      const late = {
        issuedAt,
        expiresAt: new Date("2026-11-21T20:00:00Z"),
        oneshot: { validityHours: 4 },
      };
      expect(oneshotClaim(late as never, report, "0.5.1").expiresAt.toISOString()).toBe(
        "2026-11-20T10:00:00.000Z",
      );
    });

    it("needs RESTOW_BAREMETAL_ONESHOT, the release and a session of four hours at least", async () => {
      const target = await machine();
      appConfig.baremetalOneshot = false;
      await expect(issue(target.id)).rejects.toMatchObject({
        status: 409,
        extensions: { reason: "oneshot_off" },
      });
      appConfig.baremetalOneshot = true;
      await expect(issue(target.id, { requireApproval: false })).rejects.toMatchObject({
        status: 422,
      });
      await expect(issue(target.id, { validityHours: 2 })).rejects.toMatchObject({ status: 422 });
      const { issueRecoveryCodeSchema } = await import("./schemas.js");
      expect(
        issueRecoveryCodeSchema.safeParse({ kind: "oneshot", requireApproval: false }).success,
      ).toBe(false);
      expect(issueRecoveryCodeSchema.safeParse({ kind: "oneshot", validityHours: 3 }).success).toBe(
        false,
      );
      expect(issueRecoveryCodeSchema.parse({ kind: "oneshot" }).validityHours).toBe(12);
      expect(issueRecoveryCodeSchema.parse({}).validityHours).toBe(4);
    });
  });

  describe("the exchange", () => {
    it("takes a oneshot code only at /oneshot, and a code of the ISO only at /sessions", async () => {
      const target = await machine();
      const oneshot = await issue(target.id);
      const side = commandSide(oneshot.code, ORIGIN);
      // The oneshot proof at the ISO's exchange: unknown.
      const atIso = await post("/sessions", exchangeBody(side));
      expect(atIso.status).toBe(401);
      expect((await stored(oneshot.id))?.status).toBe("issued");
      // The ISO's proof of the same code at /oneshot: unknown too (another prefix).
      const normalized = normalizeOneshotCode(oneshot.code) as string;
      const isoProof = { ...side, codeProof: recoveryCodeProof(ORIGIN, normalized) };
      expect((await post("/oneshot", oneshotBody(isoProof))).status).toBe(401);
      // A code of the ISO at /oneshot: unknown.
      const code = await codes.issueRecoveryCode(
        shared.db,
        fixture.tenantId,
        target.id,
        { validityHours: 4, requireApproval: true } as never,
        actor(),
        instance,
      );
      const iso = isoSide(code.code, ORIGIN);
      const normalizedCode = normalizeRecoveryCode(code.code) as string;
      expect(
        (
          await post(
            "/oneshot",
            oneshotBody({ ...iso, codeProof: recoveryCodeProof(ORIGIN, normalizedCode) }),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await post(
            "/oneshot",
            oneshotBody({ ...iso, codeProof: oneshotCodeProof(ORIGIN, normalizedCode) }),
          )
        ).status,
      ).toBe(401);
      expect((await stored(code.id))?.status).toBe("issued");
      // A oneshot exchange without the machine's report is malformed.
      expect((await post("/oneshot", exchangeBody(side))).status).toBe(422);
    });

    it("waits for the release, keeps the machine's report apart and moves the expiry to the session's end", async () => {
      const s = await session();
      expect(s.status).toBe("pending_approval");
      expect(Date.parse(s.expiresAt) - Date.parse(s.issued.expiresAt)).toBeGreaterThan(
        11 * 60 * 60 * 1000,
      );
      expect(s.oneshot.iso).toEqual({
        version: "0.5.0",
        fileName: "restow-recovery_0.5.0_amd64.iso",
        sha256: ISO_SHA256,
        sizeBytes: ISO_BYTES.length,
      });
      expect(s.oneshot.needs).toEqual({ passphrase: false, ramBytes: 2 * 1024 ** 3 });
      const row = await stored(s.sessionId);
      expect(row?.oneshot?.reported).toMatchObject({
        target: TARGET,
        checks: CHECKS_NOT_TRIED,
        sshKeys: SSH_KEYS,
      });
      expect(row?.oneshot?.decided).toBeUndefined();
      const started = await audits("endpoint.recovery.started", s.sessionId);
      expect(started).toHaveLength(1);
      expect(started[0]?.details).toMatchObject({ kind: "oneshot", status: "pending_approval" });
      // The same proof with the same secret answers the same session (a lost answer).
      const again = await post("/oneshot", oneshotBody(s));
      expect(again.status).toBe(202);
      expect(((await again.json()) as { sessionId: string }).sessionId).toBe(s.sessionId);
      // Another secret for a used code: 409.
      const other = { ...s, sessionSecretSha256: hashSecret(randomBytes(32).toString("hex")) };
      expect((await post("/oneshot", oneshotBody(other))).status).toBe(409);
    });

    it("tells the command when the layout has LUKS volumes", async () => {
      const target = await machine();
      await fixture.db
        .update(endpointLayouts)
        .set({ manifest: { luks: [{ id: "cryptroot" }] } })
        .where(eq(endpointLayouts.endpointId, target.id));
      const issued = await issue(target.id);
      const response = await post("/oneshot", oneshotBody(commandSide(issued.code, ORIGIN)));
      expect(response.status).toBe(202);
      expect(
        ((await response.json()) as { oneshot: { needs: { passphrase: boolean } } }).oneshot.needs
          .passphrase,
      ).toBe(true);
    });
  });

  describe("the release", () => {
    it("needs the answers and a machine that has shown it can switch", async () => {
      const s = await session();
      await expect(approve(s.endpointId, s.sessionId, null)).rejects.toMatchObject({ status: 422 });
      await expect(approve(s.endpointId, s.sessionId, withCode(s))).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:oneshot-not-ready",
        extensions: { reason: "kexec_not_tried" },
      });
      const failed = await post(
        "/sessions/current/oneshot/checks",
        { ...CHECKS_NOT_TRIED, kexec: "failed", kexecError: "EKEYREJECTED" },
        s.auth,
      );
      expect(failed.status).toBe(204);
      await expect(approve(s.endpointId, s.sessionId, withCode(s))).rejects.toMatchObject({
        extensions: { reason: "kexec_failed" },
      });
      expect((await stored(s.sessionId))?.status).toBe("pending_approval");
      expect(await audits("endpoint.recovery.approved", s.sessionId)).toHaveLength(0);
      // The direct mode in a rescue system needs no test load.
      await post(
        "/sessions/current/oneshot/checks",
        { ...CHECKS_NOT_TRIED, mode: "direct" },
        s.auth,
      );
      const dto = await approve(s.endpointId, s.sessionId, withCode(s, { remoteAccess: true }));
      expect(dto).toMatchObject({ status: "active", kind: "oneshot" });
      const row = await stored(s.sessionId);
      expect(row?.oneshot?.decided).toMatchObject({
        ...ANSWERS,
        remoteAccess: true,
        by: fixture.adminId,
      });
      // The match code is a check, no decision: it is not kept.
      expect(row?.oneshot?.decided).not.toHaveProperty("matchCode");
      // The machine's report is still its own.
      expect(row?.oneshot?.reported?.target).toEqual(TARGET);
      const current = await get("/sessions/current", s.auth);
      expect(await current.json()).toMatchObject({
        status: "active",
        oneshot: { booted: false, decided: { networkMode: "takeover", remoteAccess: true } },
      });
      // Checks after the release are refused.
      expect(
        (await post("/sessions/current/oneshot/checks", CHECKS_NOT_TRIED, s.auth)).status,
      ).toBe(409);
    });

    it("refuses a machine with an enrolled agent, and answers for a code of the ISO", async () => {
      const s = await session({
        checks: { ...CHECKS_NOT_TRIED, kexec: "ok", inUse: ["agent_enrolled"] },
      });
      await expect(approve(s.endpointId, s.sessionId, withCode(s))).rejects.toMatchObject({
        extensions: { reason: "agent_enrolled" },
      });
      const target = await machine();
      const code = await codes.issueRecoveryCode(
        shared.db,
        fixture.tenantId,
        target.id,
        { validityHours: 4, requireApproval: true } as never,
        actor(),
        instance,
      );
      const iso = isoSide(code.code, ORIGIN);
      const exchanged = await post("/sessions", exchangeBody(iso));
      const { sessionId } = (await exchanged.json()) as { sessionId: string };
      await expect(approve(target.id, sessionId, ANSWERS)).rejects.toMatchObject({ status: 422 });
    });

    it("needs the match code the machine shows, refuses and audits another one", async () => {
      const s = await session({ checks: { ...CHECKS_NOT_TRIED, kexec: "ok" } });
      const wrong = String((Number(s.matchCode) + 1) % 1_000_000).padStart(6, "0");
      await expect(
        approve(s.endpointId, s.sessionId, { ...ANSWERS, matchCode: wrong }),
      ).rejects.toMatchObject({
        status: 422,
        type: "urn:restow:problem:recovery-match-code-mismatch",
      });
      expect((await stored(s.sessionId))?.status).toBe("pending_approval");
      expect(await audits("endpoint.recovery.match_code_mismatch", s.sessionId)).toHaveLength(1);
      expect(await audits("endpoint.recovery.approved", s.sessionId)).toHaveLength(0);
      // Without a match code the answers are incomplete (the schema of the route).
      const { approveOneshotSchema } = await import("./schemas.js");
      expect(approveOneshotSchema.safeParse(ANSWERS).success).toBe(false);
      expect(approveOneshotSchema.safeParse({ ...ANSWERS, matchCode: "12345" }).success).toBe(
        false,
      );
      expect(approveOneshotSchema.safeParse({ ...ANSWERS, matchCode: "123 456" }).success).toBe(
        true,
      );
      // Six digits without the space count as well.
      const dto = await approve(s.endpointId, s.sessionId, { ...ANSWERS, matchCode: s.matchCode });
      expect(dto.status).toBe("active");
    });

    it("refuses the release while the restore onto a fresh machine is switched off", async () => {
      const s = await session({ checks: { ...CHECKS_NOT_TRIED, kexec: "ok" } });
      for (const flag of ["baremetalOneshot", "baremetalPreview"] as const) {
        appConfig[flag] = false;
        await expect(approve(s.endpointId, s.sessionId, withCode(s))).rejects.toMatchObject({
          status: 409,
          extensions: { reason: "oneshot_off" },
        });
        appConfig[flag] = true;
      }
      expect((await stored(s.sessionId))?.status).toBe("pending_approval");
    });
  });

  describe("the switches RESTOW_BAREMETAL_ONESHOT and RESTOW_BAREMETAL_PREVIEW", () => {
    it("answer the exchange as for an unknown code and close the session's routes when off", async () => {
      const s = await session();
      for (const flag of ["baremetalOneshot", "baremetalPreview"] as const) {
        appConfig[flag] = false;
        cache.forgetRecoverySession();
        const target = await machine();
        appConfig[flag] = true;
        const issued = await issue(target.id);
        appConfig[flag] = false;
        const exchanged = await post("/oneshot", oneshotBody(commandSide(issued.code, ORIGIN)));
        expect(exchanged.status).toBe(401);
        expect(((await exchanged.json()) as { type: string }).type).toBe(
          "urn:restow:problem:recovery-code-invalid",
        );
        expect((await stored(issued.id))?.status).toBe("issued");
        expect((await get("/sessions/current/iso", s.auth)).status).toBe(404);
        expect((await get("/sessions/current/iso/sums", s.auth)).status).toBe(404);
        expect(
          (await post("/sessions/current/oneshot/checks", CHECKS_NOT_TRIED, s.auth)).status,
        ).toBe(404);
        expect(
          (await post("/sessions/current/oneshot/booted", { hardware: HARDWARE }, s.auth)).status,
        ).toBe(404);
        appConfig[flag] = true;
      }
      expect((await get("/sessions/current/iso/sums", s.auth)).status).toBe(200);
    });
  });

  describe("the key release", () => {
    it("hands out no credentials and no repository read before the recovery environment reports back", async () => {
      const waiting = await session();
      const early = await get("/sessions/current/credentials", waiting.auth);
      expect(early.status).toBe(409);
      expect(((await early.json()) as { type: string }).type).toBe(
        "urn:restow:problem:recovery-not-booted",
      );
      // Not before the release either.
      expect(
        (await post("/sessions/current/oneshot/booted", { hardware: HARDWARE }, waiting.auth))
          .status,
      ).toBe(409);

      const s = await released();
      const beforeBoot = await get("/sessions/current/credentials", s.auth);
      expect(beforeBoot.status).toBe(409);
      const read = await restic.resolveRecoveryCredential(
        { runId: s.sessionId, token: s.sessionSecret },
        s.sessionId,
        Date.now(),
        { consume: () => ({ allowed: true, retryAfterMs: 0 }) } as never,
      );
      expect(read).toEqual({ ok: false, reason: "invalid" });
      expect(await audits("endpoint.recovery.credentials_issued", s.sessionId)).toHaveLength(0);

      const booted = await post("/sessions/current/oneshot/booted", { hardware: HARDWARE }, s.auth);
      expect(booted.status, await booted.clone().text()).toBe(200);
      expect(await audits("endpoint.recovery.booted", s.sessionId)).toHaveLength(1);
      // Again with the same hardware: the same answer, no second entry.
      expect(
        (await post("/sessions/current/oneshot/booted", { hardware: HARDWARE }, s.auth)).status,
      ).toBe(200);
      expect(await audits("endpoint.recovery.booted", s.sessionId)).toHaveLength(1);
      cache.forgetRecoverySession();
      const credentials = await get("/sessions/current/credentials", s.auth);
      expect(credentials.status, await credentials.clone().text()).toBe(200);
      expect(credentials.headers.get("cache-control")).toBe("no-store");
      const resolved = await restic.resolveRecoveryCredential(
        { runId: s.sessionId, token: s.sessionSecret },
        s.sessionId,
        Date.now() + 10_000,
        { consume: () => ({ allowed: true, retryAfterMs: 0 }) } as never,
      );
      expect(resolved.ok).toBe(true);
    });

    it("ends the session when the recovery environment finds other hardware", async () => {
      const s = await released();
      const other = { ...HARDWARE, disks: [{ ...HARDWARE.disks[0], serial: "OTHER" }] };
      const response = await post("/sessions/current/oneshot/booted", { hardware: other }, s.auth);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ status: "failed", reason: "hardware_changed" });
      const row = await stored(s.sessionId);
      expect(row?.status).toBe("failed");
      expect(row?.oneshot?.booted).toBeUndefined();
      const finished = await audits("endpoint.recovery.finished", s.sessionId);
      expect(finished[0]?.details).toMatchObject({ status: "failed", reason: "hardware_changed" });
      cache.forgetRecoverySession();
      expect((await get("/sessions/current/credentials", s.auth)).status).not.toBe(200);
    });
  });

  describe("the ISO through the session", () => {
    it("serves the verified copy and its signed checksums, three times, never after the switch", async () => {
      const s = await session();
      const sums = await get("/sessions/current/iso/sums", s.auth);
      expect(sums.status).toBe(200);
      expect(await sums.text()).toContain(
        `${ISO_SHA256}  recovery/restow-recovery_0.5.0_amd64.iso`,
      );
      const signature = await get("/sessions/current/iso/signature", s.auth);
      expect(signature.status).toBe(200);
      expect(await signature.text()).toContain("BEGIN SSH SIGNATURE");
      for (let time = 0; time < 3; time++) {
        const iso = await get("/sessions/current/iso", s.auth);
        expect(iso.status).toBe(200);
        expect(Buffer.from(await iso.arrayBuffer()).equals(ISO_BYTES)).toBe(true);
      }
      expect((await get("/sessions/current/iso", s.auth)).status).toBe(429);
      expect((await stored(s.sessionId))?.oneshot?.isoDownloads).toBe(3);
      // Each download of the image is audited, the refused fourth is not.
      const downloads = await audits("endpoint.recovery.iso_downloaded", s.sessionId);
      expect(downloads.map((row) => (row.details as { download: number }).download).sort()).toEqual(
        [1, 2, 3],
      );
      expect(downloads[0]?.details).toMatchObject({
        fileName: "restow-recovery_0.5.0_amd64.iso",
      });
    });

    it("answers 404 for another kind and 409 after the switch", async () => {
      const target = await machine();
      const code = await codes.issueRecoveryCode(
        shared.db,
        fixture.tenantId,
        target.id,
        { validityHours: 4, requireApproval: false } as never,
        actor(),
        instance,
      );
      const iso = isoSide(code.code, ORIGIN);
      const exchanged = await post("/sessions", exchangeBody(iso));
      const { sessionId } = (await exchanged.json()) as { sessionId: string };
      expect(
        (await get("/sessions/current/iso", sessionBasic(sessionId, iso.sessionSecret))).status,
      ).toBe(404);
      expect(
        (
          await post(
            "/sessions/current/oneshot/checks",
            CHECKS_NOT_TRIED,
            sessionBasic(sessionId, iso.sessionSecret),
          )
        ).status,
      ).toBe(404);

      const s = await released();
      expect(
        (await post("/sessions/current/oneshot/booted", { hardware: HARDWARE }, s.auth)).status,
      ).toBe(200);
      cache.forgetRecoverySession();
      expect((await get("/sessions/current/iso", s.auth)).status).toBe(409);
    });

    it("answers 404 when the installation has no copy here", async () => {
      appConfig.recoveryIsoDir = null;
      const s = await session();
      expect(s.oneshot.iso).toBeNull();
      expect((await get("/sessions/current/iso", s.auth)).status).toBe(404);
    });
  });

  it("serves oneshot.sh only when the restore onto a fresh machine is switched on", async () => {
    const { installRoutes } = await import("./install-routes.js");
    const { errorHandler } = await import("../../problem.js");
    const site = new Hono();
    site.onError(errorHandler);
    site.route("/install", installRoutes);
    const publicUrl = appConfig.publicUrl;
    appConfig.publicUrl = ORIGIN;
    try {
      appConfig.baremetalOneshot = false;
      expect((await site.request("/install/oneshot.sh")).status).toBe(404);
      appConfig.baremetalOneshot = true;
      const response = await site.request("/install/oneshot.sh");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/x-shellscript");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(body).toContain(`INSTANCE_URL='${ORIGIN}'`);
      expect(body).not.toContain("__RESTOW_URL__");
      expect(body).toContain('restow-agent" oneshot --instance');
      // No code and no secret: the admin passes the code as the argument.
      expect(body).not.toMatch(/OS-(?!X{5})[0-9A-Z]{5}-/);
    } finally {
      appConfig.publicUrl = publicUrl;
    }
  });
});
