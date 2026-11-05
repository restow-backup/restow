/**
 * Recovery codes and sessions against Postgres (docs/BAREMETAL.md 9, 21.2), bare metal M3:
 *
 *   - issuing: bound to the instance's origin, with the check value (measured or configured), the
 *     release switch, every reason the code is refused for, at most three open codes, the 48 hour
 *     CHECK; the code itself is never stored;
 *   - the exchange: a proof for another origin is unknown (401), the same session again only within
 *     15 minutes and before the release, another session secret 409, expired and revoked 410, a dead
 *     code is audited and alerted and counts no failure, unknown proofs count in the recovery's own
 *     tracker and never in the agents', a body over 64 KiB is 413, an old ISO 426 without using up
 *     the code;
 *   - the release: no credentials before it, a release after 30 minutes fails the session;
 *   - the credentials: once and once more within five minutes, `no-store`, never after `release`;
 *   - the states (9.9): every transition writes exactly one audit entry, a request that changes
 *     nothing writes none; a cancelled session still reports but reads nothing;
 *   - the log (redacted, without escape sequences, capped), the SSH keys, extending.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser. No restic: the
 * machines are inserted, not enrolled (recovery-restic.pg.test.ts reads through the route).
 */
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  hashRecoveryCodeProof,
  normalizeRecoveryCode,
  recoveryCodeProof,
  recoveryMatchCode,
} from "@restow/core";
import {
  auditLog,
  endpointRecoveries,
  endpointRecoveryLog,
  endpointReports,
  endpoints,
  notifications,
  reportDeliveries,
  reportRules,
} from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type EndpointFixture, startFixture, testDatabaseAdminUrl } from "./testing/fixture.js";
import {
  agentRootWithIso,
  exchangeBody,
  insertMachine,
  isoSide,
  sessionBasic,
} from "./testing/recovery.js";

const DATABASE = "restow_api_recovery_test";
const ORIGIN = "https://restow.firma.de";
const SPKI = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

describe.skipIf(!testDatabaseAdminUrl)("recovery codes and sessions", () => {
  let fixture: EndpointFixture;
  let app: Hono;
  let codes: typeof import("./recovery-codes.js");
  let service: typeof import("./recovery-service.js");
  let cache: typeof import("./recovery-session-cache.js");
  let agentAuth: typeof import("./agent-auth.js");
  let tls: typeof import("./instance-tls.js");
  let shared: typeof import("../../db.js");
  let appConfig: typeof import("../../config.js")["config"];
  let storeSecret: (tenantId: string, plaintext: string) => Promise<string>;
  let isoRoot = "";
  let noIsoRoot = "";
  let ip = 1;
  const actor = () => ({
    label: "admin@contoso.example",
    userId: fixture.adminId,
    ip: "192.0.2.1",
  });
  const instance = { url: ORIGIN, configured: true };

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    isoRoot = await agentRootWithIso(true);
    noIsoRoot = await agentRootWithIso(false);
    process.env.RESTOW_AGENT_DIR = isoRoot;
    shared = await import("../../db.js");
    appConfig = (await import("../../config.js")).config;
    codes = await import("./recovery-codes.js");
    service = await import("./recovery-service.js");
    cache = await import("./recovery-session-cache.js");
    agentAuth = await import("./agent-auth.js");
    tls = await import("./instance-tls.js");
    const secrets = await import("../../lib/secrets.js");
    storeSecret = async (tenantId, plaintext) =>
      (await secrets.storeSecret(shared.db, { tenantId, kind: "endpoint_repository", plaintext }))
        .id;
    const { recoveryRoutes } = await import("./recovery-routes.js");
    const { agentRoutes } = await import("./agent-routes.js");
    const { requestBodyLimit } = await import("../../middleware/body-limit.js");
    const { errorHandler } = await import("../../problem.js");
    app = new Hono();
    app.onError(errorHandler);
    app.use("*", requestBodyLimit);
    // In the order of app.ts: the recovery API ahead of the agent API and its sign-in.
    app.route("/agent/v1/recovery", recoveryRoutes);
    app.route("/agent/v1", agentRoutes);
    await fixture.db.insert(reportRules).values({
      tenantId: fixture.tenantId,
      name: "Security",
      trigger: "event",
      events: [
        "endpoint.recovery.started",
        "endpoint.recovery_code.rejected",
        "endpoint.recovery.failed",
      ],
      emailRecipients: ["it@contoso.example"],
    });
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
    await rm(isoRoot, { recursive: true, force: true });
    await rm(noIsoRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    appConfig.baremetalPreview = true;
    appConfig.publicTlsSpki = SPKI;
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
      { validityHours: 4, requireApproval: true, ...input } as never,
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
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const get = (path: string, headers: Record<string, string>) =>
    app.request(`/agent/v1/recovery${path}`, {
      headers: { "x-forwarded-for": `198.51.100.${ip++ % 250}`, ...headers },
    });

  /** Issue a code and exchange it; answers what the ISO holds. */
  async function session(options: { requireApproval?: boolean; endpointId?: string } = {}) {
    const target = options.endpointId ? { id: options.endpointId } : await machine();
    const issued = await issue(target.id, { requireApproval: options.requireApproval ?? true });
    const iso = isoSide(issued.code, ORIGIN);
    const response = await post("/sessions", exchangeBody(iso));
    expect(response.status, await response.clone().text()).toBe(202);
    const body = (await response.json()) as { sessionId: string; status: string };
    return {
      ...iso,
      ...body,
      endpointId: target.id,
      auth: sessionBasic(body.sessionId, iso.sessionSecret),
    };
  }

  const audits = (action: string, recoveryId: string) =>
    fixture.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, action), sql`${auditLog.details}->>'recoveryId' = ${recoveryId}`),
      );

  const recoveryAudits = async (recoveryId: string) =>
    (
      await fixture.db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(sql`${auditLog.details}->>'recoveryId' = ${recoveryId}`)
        .orderBy(auditLog.createdAt)
    ).map((row) => row.action);

  const stored = async (id: string) =>
    (await fixture.db.select().from(endpointRecoveries).where(eq(endpointRecoveries.id, id)))[0];

  describe("issuing", () => {
    it("binds the code to the instance's origin, stores only the hash of its proof and audits without it", async () => {
      const target = await machine();
      const issued = await issue(target.id);
      expect(issued.code).toMatch(/^RC(?:-[0-9A-HJKMNP-TV-X]{5}){5}$/);
      expect(issued).toMatchObject({
        instanceOrigin: ORIGIN,
        instanceOriginConfigured: true,
        spkiCheck: "T6DN-BAMI-JR6W-LGRP",
        snapshotId: target.snapshotId,
        requireApproval: true,
        iso: { version: "0.5.0", verified: true, sha256: "b".repeat(64) },
      });
      const row = await stored(issued.id);
      const normalized = normalizeRecoveryCode(issued.code) as string;
      expect(row?.codeHash).toBe(hashRecoveryCodeProof(recoveryCodeProof(ORIGIN, normalized)));
      expect(row?.status).toBe("issued");
      expect(row?.spkiSha256).toBe(SPKI);
      expect(JSON.stringify(row)).not.toContain(normalized);
      const [created] = await audits("endpoint.recovery_code.created", issued.id);
      expect(created?.details).toMatchObject({
        kind: "code",
        validityHours: 4,
        requireApproval: true,
        snapshotId: target.snapshotId,
      });
      expect(JSON.stringify(created)).not.toContain(normalized);
      expect(created?.actorUserId).toBe(fixture.adminId);
    });

    it("measures the check value of its own address when none is configured, and may have none", async () => {
      appConfig.publicTlsSpki = null;
      const measure = vi.spyOn(tls.instanceTls, "measure");
      measure.mockResolvedValueOnce("0".repeat(64));
      const target = await machine();
      expect((await issue(target.id)).spkiCheck).toBe("AAAA-AAAA-AAAA-AAAA");
      expect(measure).toHaveBeenCalledWith(ORIGIN, { timeoutMs: 5000 });
      measure.mockResolvedValueOnce(null);
      expect((await issue(target.id)).spkiCheck).toBeNull();
      measure.mockRestore();
    });

    it("refuses each case the ISO cannot help with, with its reason", async () => {
      const reason = async (promise: Promise<unknown>) => {
        const error = (await promise.catch((caught: unknown) => caught)) as {
          status?: number;
          type?: string;
          extensions?: { reason?: string };
        };
        expect(error.status).toBe(409);
        expect(error.type).toBe("urn:restow:problem:baremetal-not-available");
        return error.extensions?.reason;
      };
      const linux = await machine();
      appConfig.baremetalPreview = false;
      expect(await reason(issue(linux.id))).toBe("preview_off");
      appConfig.baremetalPreview = true;
      expect(await reason(issue((await machine({ os: "windows" })).id))).toBe("not_linux");
      const removed = await machine();
      await fixture.db
        .update(endpoints)
        .set({
          status: "revoked",
          removedAt: new Date(),
          removal: {
            mode: "expire",
            state: "scheduled",
            requestedBy: "admin",
            requestedAt: new Date().toISOString(),
          },
        })
        .where(eq(endpoints.id, removed.id));
      expect(await reason(issue(removed.id))).toBe("removed");
      expect(await reason(issue((await machine({ layout: false })).id))).toBe("no_layout");
      expect(await reason(issue((await machine({ verdict: "unsupported" })).id))).toBe(
        "unsupported",
      );
      expect(await reason(issue(linux.id, { snapshotId: "c".repeat(64) }))).toBe(
        "snapshot_unknown",
      );
      process.env.RESTOW_AGENT_DIR = noIsoRoot;
      expect(await reason(issue(linux.id))).toBe("iso_unverified");
      // A revoked machine is often the broken one: it gets a code.
      const revoked = await machine({ status: "revoked" });
      process.env.RESTOW_AGENT_DIR = isoRoot;
      await expect(issue(revoked.id)).resolves.toMatchObject({ requireApproval: true });
    });

    it("keeps at most three codes open and never more than 48 hours", async () => {
      const target = await machine();
      for (let n = 0; n < 3; n++) {
        await issue(target.id);
      }
      await expect(issue(target.id)).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:recovery-limit-reached",
      });
      const [first] = await fixture.db
        .select()
        .from(endpointRecoveries)
        .where(eq(endpointRecoveries.endpointId, target.id));
      const refused = await fixture.db
        .update(endpointRecoveries)
        .set({ expiresAt: sql`issued_at + interval '49 hours'` })
        .where(eq(endpointRecoveries.id, first?.id as string))
        .then(
          () => null,
          (error: { cause?: { constraint?: string } }) => error.cause?.constraint,
        );
      expect(refused).toBe("endpoint_recoveries_max_48h");
      // Revoking one makes room again.
      await codes.revokeRecoveryCode(
        shared.db,
        fixture.tenantId,
        target.id,
        first?.id as string,
        actor(),
      );
      await expect(issue(target.id)).resolves.toMatchObject({ requireApproval: true });
    });
  });

  describe("the exchange", () => {
    it("opens a session that waits for its release, with the match code, and alerts", async () => {
      const target = await machine();
      const issued = await issue(target.id);
      const iso = isoSide(issued.code, ORIGIN);
      const response = await post("/sessions", exchangeBody(iso));
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({
        sessionId: issued.id,
        status: "pending_approval",
        matchCode: recoveryMatchCode(iso.sessionSecretSha256),
        expiresAt: issued.expiresAt,
        endpoint: { id: target.id, hostname: expect.any(String), displayName: null, os: "linux" },
        minRecoveryVersion: "0.5.0",
      });
      const row = await stored(issued.id);
      expect(row).toMatchObject({ status: "pending_approval", recoveryVersion: "0.5.0" });
      expect(row?.sessionSecretHash).toBe(iso.sessionSecretSha256);
      expect(row?.hardware?.disks[0]?.model).toBe("Samsung SSD 980");
      const [started] = await audits("endpoint.recovery.started", issued.id);
      expect(started?.details).toMatchObject({
        recoveryVersion: "0.5.0",
        hardware: { firmware: "uefi", disks: 1, nics: 1 },
      });
      const [bell] = await fixture.db
        .select()
        .from(notifications)
        .where(sql`${notifications.details}->>'recoveryId' = ${issued.id}`);
      expect(bell).toMatchObject({ event: "endpoint.recovery.started", level: "error" });
      const queued = await fixture.db
        .select()
        .from(reportDeliveries)
        .where(eq(reportDeliveries.event, "endpoint.recovery.started"));
      expect(queued.some((delivery) => delivery.recipient === "it@contoso.example")).toBe(true);
    });

    it("finds nothing for a proof made for another address, and counts that in its own tracker only", async () => {
      const issued = await issue((await machine()).id);
      const authRecord = vi.spyOn(agentAuth.authFailures, "record");
      const before = service.recoveryExchangeFailuresTotal.get("unknown") ?? 0;
      const phishing = isoSide(issued.code, "https://restow-firma.de");
      const response = await post("/sessions", exchangeBody(phishing), {
        "x-forwarded-for": "203.0.113.200",
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { type: string }).type).toBe(
        "urn:restow:problem:recovery-code-invalid",
      );
      expect(service.recoveryExchangeFailuresTotal.get("unknown")).toBe(before + 1);
      expect(authRecord).not.toHaveBeenCalled();
      authRecord.mockRestore();
      // 20 failures from one address block it for the exchange.
      for (let n = 1; n < 20; n++) {
        await post("/sessions", exchangeBody(phishing), { "x-forwarded-for": "203.0.113.200" });
      }
      expect(
        (
          await post("/sessions", exchangeBody(isoSide(issued.code, ORIGIN)), {
            "x-forwarded-for": "203.0.113.200",
          })
        ).status,
      ).toBe(429);
      expect(agentAuth.authFailures.isBlocked("203.0.113.200", Date.now())).toBe(false);
      // The code is still good from another address.
      expect((await post("/sessions", exchangeBody(isoSide(issued.code, ORIGIN)))).status).toBe(
        202,
      );
    });

    it("answers the same session again only within 15 minutes and before the release", async () => {
      const issued = await issue((await machine()).id);
      const iso = isoSide(issued.code, ORIGIN);
      expect((await post("/sessions", exchangeBody(iso))).status).toBe(202);
      const again = await post("/sessions", exchangeBody(iso));
      expect(again.status).toBe(202);
      expect(((await again.json()) as { sessionId: string }).sessionId).toBe(issued.id);
      expect(await audits("endpoint.recovery.started", issued.id)).toHaveLength(1);
      const later = new Date(Date.now() + 16 * 60 * 1000);
      await expect(
        service.exchangeRecoveryCode(
          exchangeBody(iso) as never,
          { ip: null, failureKey: "x" },
          later,
        ),
      ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:recovery-code-used" });
    });

    it("refuses another session secret, an expired and a revoked code, and tells the tenant", async () => {
      const failures = () =>
        [...service.recoveryExchangeFailuresTotal.values()].reduce((sum, n) => sum + n, 0);
      const counted = failures();
      const used = await session();
      const other = await post(
        "/sessions",
        exchangeBody({ codeProof: used.codeProof, sessionSecretSha256: "f".repeat(64) }),
      );
      expect(other.status).toBe(409);
      expect(((await other.json()) as { type: string }).type).toBe(
        "urn:restow:problem:recovery-code-used",
      );
      const expired = await issue((await machine()).id);
      await fixture.db
        .update(endpointRecoveries)
        .set({ expiresAt: new Date(Date.now() - 1000), issuedAt: new Date(Date.now() - 3600_000) })
        .where(eq(endpointRecoveries.id, expired.id));
      const expiredAnswer = await post("/sessions", exchangeBody(isoSide(expired.code, ORIGIN)));
      expect(expiredAnswer.status).toBe(410);
      expect(((await expiredAnswer.json()) as { type: string }).type).toBe(
        "urn:restow:problem:recovery-code-expired",
      );
      const revokedTarget = await machine();
      const revoked = await issue(revokedTarget.id);
      await codes.revokeRecoveryCode(
        shared.db,
        fixture.tenantId,
        revokedTarget.id,
        revoked.id,
        actor(),
      );
      const revokedAnswer = await post("/sessions", exchangeBody(isoSide(revoked.code, ORIGIN)));
      expect(revokedAnswer.status).toBe(410);
      expect(((await revokedAnswer.json()) as { type: string }).type).toBe(
        "urn:restow:problem:recovery-code-revoked",
      );
      for (const [id, reason] of [
        [used.sessionId, "used"],
        [expired.id, "expired"],
        [revoked.id, "revoked"],
      ] as const) {
        const [rejected] = await audits("endpoint.recovery_code.rejected", id);
        expect(rejected?.details).toMatchObject({ reason, recoveryVersion: "0.5.0" });
        const bells = await fixture.db
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.event, "endpoint.recovery_code.rejected"),
              sql`${notifications.details}->>'recoveryId' = ${id}`,
            ),
          );
        expect(bells).toHaveLength(1);
      }
      // Whoever holds the proof may learn why: no failure was counted.
      expect(failures()).toBe(counted);
    });

    it("refuses an old ISO without using up the code, and a body over 64 KiB", async () => {
      const issued = await issue((await machine()).id);
      const iso = isoSide(issued.code, ORIGIN);
      const old = await post("/sessions", exchangeBody(iso, { recoveryVersion: "0.4.9" }));
      expect(old.status).toBe(426);
      expect(await old.json()).toMatchObject({
        type: "urn:restow:problem:recovery-too-old",
        minRecoveryVersion: "0.5.0",
      });
      expect((await stored(issued.id))?.status).toBe("issued");
      const huge = await post("/sessions", JSON.stringify({ padding: "x".repeat(70 * 1024) }));
      expect(huge.status).toBe(413);
      expect((await post("/sessions", exchangeBody(iso))).status).toBe(202);
      // Too many disks is a malformed body.
      const disks = Array.from({ length: 65 }, () => exchangeBody(iso).hardware.disks[0]);
      const malformed = await post(
        "/sessions",
        exchangeBody(iso, { hardware: { ...exchangeBody(iso).hardware, disks } }),
      );
      expect(malformed.status).toBe(422);
      const control = await post(
        "/sessions",
        exchangeBody(iso, { recoveryVersion: "0.5.0\u001b[2J" }),
      );
      expect(control.status).toBe(422);
    });
  });

  describe("release and credentials", () => {
    it("hands out nothing before the release, then once and once more, never after release", async () => {
      const target = await machine();
      await fixture.db.insert(endpointReports).values({
        tenantId: fixture.tenantId,
        endpointId: target.id,
        kind: "baremetal_check",
        snapshotId: target.snapshotId,
        readiness: "green",
        summary: { restoreSizes: { "/": { bytes: 10, files: 2, inodes: 3 } } },
      });
      const s = await session({ endpointId: target.id });
      const early = await get("/sessions/current/credentials", s.auth);
      expect(early.status).toBe(409);
      expect(((await early.json()) as { type: string }).type).toBe(
        "urn:restow:problem:recovery-not-approved",
      );
      const current = await get("/sessions/current", s.auth);
      expect(await current.json()).toMatchObject({
        sessionId: s.sessionId,
        status: "pending_approval",
        cancelRequested: false,
        approved: false,
      });
      const approved = await codes.approveRecovery(
        shared.db,
        fixture.tenantId,
        target.id,
        s.sessionId,
        actor(),
      );
      expect(approved).toMatchObject({ status: "active", approvedBy: { id: fixture.adminId } });
      expect(JSON.stringify(approved)).not.toContain(s.sessionSecretSha256);
      const first = await get("/sessions/current/credentials", s.auth);
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(await first.json()).toEqual({
        repository: {
          url: `rest:${ORIGIN}/agent/recovery/restic/${s.sessionId}/`,
          password: target.repositoryPassword,
        },
        snapshotId: target.snapshotId,
        layoutSha256: target.layoutSha256,
        snapshots: [
          {
            id: target.snapshotId,
            time: expect.any(String),
            layoutSha256: target.layoutSha256,
            check: "passed",
          },
        ],
        indexBytes: 0,
        restoreSizes: { "/": { bytes: 10, files: 2, inodes: 3 } },
        minRecoveryVersion: "0.5.0",
      });
      expect((await get("/sessions/current/credentials", s.auth)).status).toBe(200);
      const third = await get("/sessions/current/credentials", s.auth);
      expect(third.status).toBe(409);
      expect(((await third.json()) as { type: string }).type).toBe(
        "urn:restow:problem:recovery-credentials-collected",
      );
      const issuedAudits = await audits("endpoint.recovery.credentials_issued", s.sessionId);
      expect(issuedAudits.map((entry) => (entry.details as { repeat: boolean }).repeat)).toEqual([
        false,
        true,
      ]);
      const release = await post("/sessions/current/release", {}, s.auth);
      expect(release.status).toBe(200);
      expect(await release.json()).toEqual({ status: "finishing" });
      expect((await post("/sessions/current/release", {}, s.auth)).status).toBe(200);
      const after = await get("/sessions/current/credentials", s.auth);
      expect(after.status).toBe(401);
      expect(((await after.json()) as { type: string }).type).toBe(
        "urn:restow:problem:recovery-session-ended",
      );
      // The same proof and secret no longer open the session after the release.
      expect((await post("/sessions", exchangeBody(s))).status).toBe(409);
      expect(await audits("endpoint.recovery.released", s.sessionId)).toHaveLength(1);
    });

    it("gives the second fetch only within five minutes of the first", async () => {
      const s = await session({ requireApproval: false });
      expect(s.status).toBe("active");
      const access = await cache.loadRecoverySession(s.sessionId);
      if (!access) throw new Error("no session");
      await service.issueCredentials(access, null);
      await expect(
        service.issueCredentials(access, null, new Date(Date.now() + 6 * 60 * 1000)),
      ).rejects.toMatchObject({ type: "urn:restow:problem:recovery-credentials-collected" });
    });

    it("fails a session nobody released within 30 minutes, once, through a late release", async () => {
      const s = await session();
      await fixture.db
        .update(endpointRecoveries)
        .set({ usedAt: new Date(Date.now() - 31 * 60 * 1000) })
        .where(eq(endpointRecoveries.id, s.sessionId));
      await expect(
        codes.approveRecovery(shared.db, fixture.tenantId, s.endpointId, s.sessionId, actor()),
      ).rejects.toMatchObject({ status: 401, type: "urn:restow:problem:recovery-session-ended" });
      expect((await stored(s.sessionId))?.status).toBe("failed");
      await expect(
        codes.approveRecovery(shared.db, fixture.tenantId, s.endpointId, s.sessionId, actor()),
      ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:recovery-state-conflict" });
      const expired = await audits("endpoint.recovery.expired", s.sessionId);
      expect(expired).toHaveLength(1);
      expect(expired[0]?.details).toMatchObject({ reason: "not_approved", to: "failed" });
      const failed = await fixture.db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.event, "endpoint.recovery.failed"),
            sql`${notifications.details}->>'recoveryId' = ${s.sessionId}`,
          ),
        );
      expect(failed).toHaveLength(1);
    });
  });

  describe("the lock against pruning (9.5, 9.7)", () => {
    it("neither releases nor exchanges a code while retention holds the repository, and uses up nothing", async () => {
      const { acquireEndpointRepositoryLock } = await import("@restow/db");
      const waiting = await session();
      const direct = await machine();
      const code = await issue(direct.id, { requireApproval: false });
      const releaseWaiting = await acquireEndpointRepositoryLock(
        fixture.db.$client,
        waiting.endpointId,
        {
          mode: "exclusive",
        },
      );
      const releaseDirect = await acquireEndpointRepositoryLock(fixture.db.$client, direct.id, {
        mode: "exclusive",
      });
      try {
        await expect(
          codes.approveRecovery(
            shared.db,
            fixture.tenantId,
            waiting.endpointId,
            waiting.sessionId,
            actor(),
          ),
        ).rejects.toMatchObject({
          status: 503,
          type: "urn:restow:problem:endpoint-repository-locked",
        });
        const busy = await post("/sessions", exchangeBody(isoSide(code.code, ORIGIN)));
        expect(busy.status).toBe(503);
        expect(busy.headers.get("retry-after")).toBe("30");
      } finally {
        await releaseWaiting();
        await releaseDirect();
      }
      expect((await stored(waiting.sessionId))?.status).toBe("pending_approval");
      expect((await stored(code.id))?.status).toBe("issued");
      expect(await audits("endpoint.recovery.approved", waiting.sessionId)).toHaveLength(0);
      // Once it is free, both go through.
      await codes.approveRecovery(
        shared.db,
        fixture.tenantId,
        waiting.endpointId,
        waiting.sessionId,
        actor(),
      );
      expect((await post("/sessions", exchangeBody(isoSide(code.code, ORIGIN)))).status).toBe(202);
    });
  });

  describe("states (9.9)", () => {
    it("writes exactly one audit entry per transition and none without one", async () => {
      // issued -> revoked
      const revokeTarget = await machine();
      const code = await issue(revokeTarget.id);
      await codes.revokeRecoveryCode(
        shared.db,
        fixture.tenantId,
        revokeTarget.id,
        code.id,
        actor(),
      );
      await expect(
        codes.revokeRecoveryCode(shared.db, fixture.tenantId, revokeTarget.id, code.id, actor()),
      ).rejects.toMatchObject({ type: "urn:restow:problem:recovery-state-conflict" });
      expect(await recoveryAudits(code.id)).toEqual([
        "endpoint.recovery_code.created",
        "endpoint.recovery_code.revoked",
      ]);

      // issued -> pending_approval -> cancelled (rejected)
      const rejected = await session();
      await codes.cancelRecovery(
        shared.db,
        fixture.tenantId,
        rejected.endpointId,
        rejected.sessionId,
        actor(),
      );
      await expect(
        codes.cancelRecovery(
          shared.db,
          fixture.tenantId,
          rejected.endpointId,
          rejected.sessionId,
          actor(),
        ),
      ).rejects.toMatchObject({ type: "urn:restow:problem:recovery-state-conflict" });
      expect(await recoveryAudits(rejected.sessionId)).toEqual([
        "endpoint.recovery_code.created",
        "endpoint.recovery.started",
        "endpoint.recovery.cancelled",
      ]);

      // issued -> active (no release asked) -> finishing -> succeeded, extended on the way
      const good = await session({ requireApproval: false });
      expect((await stored(good.sessionId))?.status).toBe("active");
      await codes.extendRecoveryCode(
        shared.db,
        fixture.tenantId,
        good.endpointId,
        good.sessionId,
        8,
        actor(),
      );
      expect((await stored(good.sessionId))?.status).toBe("active");
      expect((await post("/sessions/current/release", {}, good.auth)).status).toBe(200);
      const finish = await post(
        "/sessions/current/finish",
        { status: "succeeded", verification: { fstab: "ok" }, warnings: [], durationSeconds: 600 },
        good.auth,
      );
      expect(await finish.json()).toEqual({ status: "succeeded" });
      expect(
        (
          await post(
            "/sessions/current/finish",
            { status: "failed", verification: {}, warnings: [], durationSeconds: 1 },
            good.auth,
          )
        ).status,
      ).toBe(409);
      expect(await recoveryAudits(good.sessionId)).toEqual([
        "endpoint.recovery_code.created",
        "endpoint.recovery.started",
        "endpoint.recovery_code.extended",
        "endpoint.recovery.released",
        "endpoint.recovery.finished",
      ]);
      expect((await stored(good.sessionId))?.verification).toEqual({ fstab: "ok" });

      // active -> failed (reported) raises the alert
      const bad = await session({ requireApproval: false });
      await post(
        "/sessions/current/finish",
        {
          status: "failed",
          verification: {},
          warnings: [{ code: "x", message: "y" }],
          durationSeconds: 5,
        },
        bad.auth,
      );
      expect(await recoveryAudits(bad.sessionId)).toEqual([
        "endpoint.recovery_code.created",
        "endpoint.recovery.started",
        "endpoint.recovery.finished",
      ]);
      expect(
        await fixture.db
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.event, "endpoint.recovery.failed"),
              sql`${notifications.details}->>'recoveryId' = ${bad.sessionId}`,
            ),
          ),
      ).toHaveLength(1);
    });

    it("lets a cancelled session report on, but read and finish nothing", async () => {
      const s = await session({ requireApproval: false });
      await codes.cancelRecovery(shared.db, fixture.tenantId, s.endpointId, s.sessionId, actor());
      const current = await get("/sessions/current", s.auth);
      expect(await current.json()).toMatchObject({ status: "cancelled", cancelRequested: true });
      expect((await get("/sessions/current/credentials", s.auth)).status).toBe(401);
      expect((await post("/sessions/current/release", {}, s.auth)).status).toBe(401);
      expect(
        (
          await post(
            "/sessions/current/finish",
            { status: "cancelled", verification: {}, warnings: [], durationSeconds: 1 },
            s.auth,
          )
        ).status,
      ).toBe(409);
      const progress = await post(
        "/sessions/current/progress",
        {
          phase: "restoring",
          step: 3,
          stepsTotal: 40,
          bytesDone: 1,
          totalBytes: 2,
          filesDone: 1,
          totalFiles: 2,
          message: "stopping",
        },
        s.auth,
      );
      expect(progress.status).toBe(204);
      expect(await recoveryAudits(s.sessionId)).toEqual([
        "endpoint.recovery_code.created",
        "endpoint.recovery.started",
        "endpoint.recovery.cancelled",
      ]);
      // A wrong secret is not the session.
      expect(
        (await get("/sessions/current", sessionBasic(s.sessionId, "0".repeat(64)))).status,
      ).toBe(401);
    });

    it("reaches the recovery API ahead of the agent API's sign-in", async () => {
      const s = await session();
      const response = await get("/sessions/current", s.auth);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("reports of the ISO", () => {
    it("stores the log without escape sequences and credentials, and at most 2 MiB", async () => {
      const s = await session({ requireApproval: false });
      const answer = await post(
        "/sessions/current/log",
        {
          lines: [
            "\u001b[32mrestoring\u001b[0m /home",
            "typed RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS",
            `sessionSecretSha256=${s.sessionSecretSha256}`,
          ],
        },
        s.auth,
      );
      expect(answer.status).toBe(202);
      expect(await answer.json()).toEqual({ accepted: 3, dropped: 0 });
      const [entry] = await fixture.db
        .select()
        .from(endpointRecoveryLog)
        .where(eq(endpointRecoveryLog.recoveryId, s.sessionId));
      expect(entry?.lines.split("\n")).toEqual([
        "restoring /home",
        "typed [redacted]",
        "sessionSecretSha256=[redacted]",
      ]);
      await fixture.db
        .update(endpointRecoveries)
        .set({ logBytes: 2 * 1024 * 1024 - 10 })
        .where(eq(endpointRecoveries.id, s.sessionId));
      const capped = await post(
        "/sessions/current/log",
        { lines: ["short", "x".repeat(100)] },
        s.auth,
      );
      expect(await capped.json()).toEqual({ accepted: 1, dropped: 1 });
      const detail = await codes.getRecovery(
        shared.db,
        fixture.tenantId,
        s.endpointId,
        s.sessionId,
        {
          logLimit: 1,
        },
      );
      expect(detail.log.items).toHaveLength(1);
      expect(detail.log.next).not.toBeNull();
      const rest = await codes.getRecovery(shared.db, fixture.tenantId, s.endpointId, s.sessionId, {
        logAfter: detail.log.next as string,
        logLimit: 10,
      });
      expect(rest.log.items.map((item) => item.lines)).toEqual([["short"]]);
      expect(rest.log.next).toBeNull();
      expect(JSON.stringify(rest)).not.toContain(s.sessionSecretSha256);
      expect(rest.matchCode).toBe(recoveryMatchCode(s.sessionSecretSha256));
      // More than 200 lines at once is refused.
      expect(
        (
          await post(
            "/sessions/current/log",
            { lines: Array.from({ length: 201 }, () => "a") },
            s.auth,
          )
        ).status,
      ).toBe(422);
    });

    it("takes the largest log batch and finish report the schemas accept (body limits)", async () => {
      const s = await session({ requireApproval: false });
      // 200 lines of 4096 characters: about 800 KiB, over the old 512 KiB limit.
      const lines = Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(4096, "x"));
      const log = await post("/sessions/current/log", { lines }, s.auth);
      expect(log.status, await log.clone().text()).toBe(202);
      expect(await log.json()).toEqual({ accepted: 200, dropped: 0 });
      // A 64 KiB report and 200 warnings of 64 + 1000 characters: about 280 KiB.
      const verification = { report: "v".repeat(64 * 1024 - '{"report":""}'.length) };
      expect(JSON.stringify(verification)).toHaveLength(64 * 1024);
      const warnings = Array.from({ length: 200 }, (_, i) => ({
        code: `${i}`.padEnd(64, "c"),
        message: "m".repeat(1000),
      }));
      const finish = await post(
        "/sessions/current/finish",
        { status: "succeeded", verification, warnings, durationSeconds: 60 },
        s.auth,
      );
      expect(finish.status, await finish.clone().text()).toBe(200);
      expect(await finish.json()).toEqual({ status: "succeeded" });
    });

    it("hands the ISO the SSH keys the admin put in, and keeps its progress and host keys", async () => {
      const s = await session();
      const key = `ssh-ed25519 ${Buffer.concat([
        Buffer.from([0, 0, 0, 11]),
        Buffer.from("ssh-ed25519"),
        Buffer.from([0, 0, 0, 32]),
        randomBytes(32),
      ]).toString("base64")} admin@laptop`;
      await codes.setRecoverySshKeys(
        shared.db,
        fixture.tenantId,
        s.endpointId,
        s.sessionId,
        [key],
        actor(),
      );
      const keys = await get("/sessions/current/ssh-keys", s.auth);
      expect(await keys.json()).toEqual({ keys: [key] });
      const [changed] = await audits("endpoint.config.changed", s.sessionId);
      expect(changed?.details).toMatchObject({ recoverySshKeys: 1 });
      await post(
        "/sessions/current/progress",
        {
          phase: "waiting_approval",
          step: 1,
          stepsTotal: 40,
          bytesDone: 0,
          totalBytes: 0,
          filesDone: 0,
          totalFiles: 0,
          message: "waiting",
          sshHostKeys: [{ type: "ssh-ed25519", fingerprint: "SHA256:abc" }],
        },
        s.auth,
      );
      const detail = await codes.getRecovery(
        shared.db,
        fixture.tenantId,
        s.endpointId,
        s.sessionId,
      );
      expect(detail).toMatchObject({
        phase: "waiting_approval",
        sshKeys: [key],
        sshHostKeys: [{ type: "ssh-ed25519", fingerprint: "SHA256:abc" }],
        hardwareSummary: { disks: 1, nics: 1 },
      });
      const event = await post(
        "/sessions/current/event",
        { kind: "remote_access_enabled", detail: { port: "22" } },
        s.auth,
      );
      expect(event.status).toBe(204);
      expect(await audits("endpoint.recovery.remote_access_enabled", s.sessionId)).toHaveLength(1);
    });

    it("extends a code up to 48 hours after it was issued and not beyond", async () => {
      const target = await machine();
      const issued = await issue(target.id);
      const extended = await codes.extendRecoveryCode(
        shared.db,
        fixture.tenantId,
        target.id,
        issued.id,
        48,
        actor(),
      );
      const row = await stored(issued.id);
      expect(row?.status).toBe("issued");
      expect((row?.expiresAt.getTime() ?? 0) - (row?.issuedAt.getTime() ?? 0)).toBe(48 * 3600_000);
      expect(extended.expiresAt).toBe(row?.expiresAt.toISOString());
      await expect(
        codes.extendRecoveryCode(shared.db, fixture.tenantId, target.id, issued.id, 48, actor()),
      ).rejects.toMatchObject({ type: "urn:restow:problem:recovery-state-conflict" });
      expect(await audits("endpoint.recovery_code.extended", issued.id)).toHaveLength(1);
      const listed = await codes.listRecoveries(shared.db, fixture.tenantId, target.id);
      expect(listed.items.map((item) => item.id)).toContain(issued.id);
      expect(JSON.stringify(listed)).not.toMatch(/codeHash|sessionSecretHash|code_hash/);
    });
  });
});
