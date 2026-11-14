import { spawn } from "node:child_process";
/**
 * The `reader` restic route of a recovery session with the real restic binary (docs/BAREMETAL.md
 * 9.6, 21.2), bare metal M3: with the credentials the session collected, the ISO's restic (with
 * `--no-lock --no-cache`) lists the snapshots and reads files of the machine's repository; every
 * write and delete is refused (403) and audited as the recovery's; a credential whose user is not
 * the session in the path is refused (401); after a cancel or a release the route answers 401 at
 * once in this process and within five seconds in any other (the state cache); the limit of
 * 120,000 requests per session holds.
 *
 * Needs Postgres (RESTOW_TEST_DATABASE_URL, a superuser) and restic (RESTIC_BINARY, else the PATH).
 * The API listens on a loopback port and the code is issued for that address.
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { resticBinary } from "@restow/core";
import { auditLog, endpointLayouts, endpointRecoveries, endpointRuns } from "@restow/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type EndpointFixture,
  resticAvailable,
  startFixture,
  testDatabaseAdminUrl,
} from "./testing/fixture.js";
import { agentRootWithIso, exchangeBody, isoSide, sessionBasic } from "./testing/recovery.js";

const DATABASE = "restow_api_recovery_restic_test";
const canRun = Boolean(testDatabaseAdminUrl) && resticAvailable();

interface Session {
  sessionId: string;
  secret: string;
  url: string;
  password: string;
}

describe.skipIf(!canRun)(
  "the reader route of a recovery session with the real restic binary",
  () => {
    let fixture: EndpointFixture;
    let shared: typeof import("../../db.js");
    let codes: typeof import("./recovery-codes.js");
    let route: typeof import("./recovery-restic-route.js");
    let cache: typeof import("./recovery-session-cache.js");
    let appConfig: typeof import("../../config.js")["config"];
    let server: ReturnType<typeof serve>;
    let port = 0;
    let work = "";
    let isoRoot = "";
    let endpointId = "";
    let snapshotId = "";
    let agentEnv: Record<string, string> = {};
    const actor = () => ({
      label: "admin@contoso.example",
      userId: fixture.adminId,
      ip: "192.0.2.1",
    });
    const origin = () => `http://127.0.0.1:${port}`;

    function restic(
      args: string[],
      env: Record<string, string>,
    ): Promise<{ code: number | null; out: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(resticBinary(), args, {
          env: { PATH: process.env.PATH ?? "", HOME: work, ...env },
        });
        let out = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
        });
        child.stderr.on("data", (chunk) => {
          out += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, out }));
      });
    }

    const asIso = (session: Session, user = session.sessionId) => ({
      RESTIC_REPOSITORY: session.url,
      RESTIC_REST_USERNAME: user,
      RESTIC_REST_PASSWORD: session.secret,
      RESTIC_PASSWORD: session.password,
    });

    /** Issue a code for this server's address, exchange it without a release, collect the credentials. */
    async function openSession(): Promise<Session> {
      const issued = await codes.issueRecoveryCode(
        shared.db,
        fixture.tenantId,
        endpointId,
        { validityHours: 4, requireApproval: false },
        actor(),
        { url: origin(), configured: true },
      );
      const iso = isoSide(issued.code, origin());
      const exchanged = await fetch(`${origin()}/agent/v1/recovery/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(exchangeBody(iso)),
      });
      expect(exchanged.status, await exchanged.clone().text()).toBe(202);
      const { sessionId } = (await exchanged.json()) as { sessionId: string };
      const credentials = await fetch(
        `${origin()}/agent/v1/recovery/sessions/current/credentials`,
        { headers: sessionBasic(sessionId, iso.sessionSecret) },
      );
      expect(credentials.status).toBe(200);
      const body = (await credentials.json()) as { repository: { url: string; password: string } };
      return {
        sessionId,
        secret: iso.sessionSecret,
        url: body.repository.url,
        password: body.repository.password,
      };
    }

    beforeAll(async () => {
      fixture = await startFixture(DATABASE);
      isoRoot = await agentRootWithIso(true);
      process.env.RESTOW_AGENT_DIR = isoRoot;
      shared = await import("../../db.js");
      appConfig = (await import("../../config.js")).config;
      appConfig.baremetalPreview = true;
      appConfig.publicTlsSpki = null;
      codes = await import("./recovery-codes.js");
      route = await import("./recovery-restic-route.js");
      cache = await import("./recovery-session-cache.js");
      const service = await import("./service.js");
      const { agentRoutes } = await import("./agent-routes.js");
      const { resticRoutes } = await import("./restic-route.js");
      const { recoveryRoutes } = await import("./recovery-routes.js");
      const { errorHandler } = await import("../../problem.js");
      const app = new Hono();
      app.onError(errorHandler);
      app.route("/agent/v1/recovery", recoveryRoutes);
      app.route("/agent/v1", agentRoutes);
      app.route("/agent/restic", resticRoutes);
      app.route("/agent/recovery/restic", route.recoveryResticRoutes);
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      port = (server.address() as AddressInfo).port;

      work = await mkdtemp(join(tmpdir(), "restow-recovery-restic-"));
      const source = join(work, "source");
      await mkdir(join(source, "etc"), { recursive: true });
      await writeFile(join(source, "etc", "hostname"), "web01\n");
      await writeFile(join(source, "etc", "fstab"), "UUID=1 / ext4 defaults 0 1\n");

      const created = await service.createEnrollmentToken(
        shared.db,
        fixture.tenantId,
        { profile: "server", os: "linux" },
        actor(),
        { url: origin(), configured: true },
      );
      const enrolled = await fetch(`${origin()}/agent/v1/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: created.token,
          hostname: "web01",
          os: "linux",
          arch: "amd64",
          agentVersion: "0.5.0",
          osVersion: "test",
        }),
      });
      expect(enrolled.status).toBe(201);
      const agent = (await enrolled.json()) as {
        endpointId: string;
        agentSecret: string;
        repository: { password: string };
      };
      endpointId = agent.endpointId;
      agentEnv = {
        RESTIC_REPOSITORY: `rest:${origin()}/agent/restic/${endpointId}/`,
        RESTIC_REST_USERNAME: endpointId,
        RESTIC_REST_PASSWORD: agent.agentSecret,
        RESTIC_PASSWORD: agent.repository.password,
        RESTIC_CACHE_DIR: join(work, "agent-cache"),
      };
      const backup = await restic(["backup", source], agentEnv);
      expect(backup.code, backup.out).toBe(0);
      const listed = await restic(["snapshots", "--json"], agentEnv);
      snapshotId = (JSON.parse(listed.out.split("\n")[0] ?? "[]") as { id: string }[])[0]?.id ?? "";
      expect(snapshotId).toMatch(/^[0-9a-f]{64}$/);
      // The backup was a whole machine backup with a layout (as finish stores it).
      const [layout] = await fixture.db
        .insert(endpointLayouts)
        .values({
          tenantId: fixture.tenantId,
          endpointId,
          sha256: randomBytes(32).toString("hex"),
          format: "restow-layout-v1",
          schemaVersion: 1,
          platform: "linux",
          manifest: {},
          summary: {},
          verdict: "supported",
          layoutFingerprint: "f",
        })
        .returning();
      await fixture.db.insert(endpointRuns).values({
        tenantId: fixture.tenantId,
        endpointId,
        kind: "backup",
        status: "succeeded",
        startedAt: new Date(),
        finishedAt: new Date(),
        snapshotId,
        layoutId: layout?.id ?? null,
      });
    }, 180_000);

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
        (server as { closeAllConnections?: () => void } | undefined)?.closeAllConnections?.();
      });
      await fixture?.cleanup();
      if (work) await rm(work, { recursive: true, force: true });
      if (isoRoot) await rm(isoRoot, { recursive: true, force: true });
    });

    afterEach(async () => {
      // At most three codes of a machine are open: each test starts from none.
      await fixture.db
        .update(endpointRecoveries)
        .set({ status: "cancelled" })
        .where(
          inArray(endpointRecoveries.status, ["issued", "pending_approval", "active", "finishing"]),
        );
      cache.forgetRecoverySession();
    });

    it("lists the snapshots and reads a file through the session's credentials", async () => {
      const session = await openSession();
      expect(session.url).toBe(`rest:${origin()}/agent/recovery/restic/${session.sessionId}/`);
      const listed = await restic(
        ["snapshots", "--json", "--no-lock", "--no-cache"],
        asIso(session),
      );
      expect(listed.code, listed.out).toBe(0);
      expect(listed.out).toContain(snapshotId);
      const dumped = await restic(
        ["dump", "--no-lock", "--no-cache", snapshotId, `${join(work, "source")}/etc/hostname`],
        asIso(session),
      );
      expect(dumped.code, dumped.out).toBe(0);
      expect(dumped.out).toBe("web01\n");
    }, 120_000);

    it("refuses every write and delete, and audits them as the recovery's", async () => {
      const session = await openSession();
      const backup = await restic(["backup", "--no-cache", join(work, "source")], asIso(session));
      expect(backup.code).not.toBe(0);
      const forget = await restic(
        ["forget", "--no-lock", "--no-cache", snapshotId],
        asIso(session),
      );
      expect(forget.code).not.toBe(0);
      const raw = await fetch(
        `${origin()}/agent/recovery/restic/${session.sessionId}/snapshots/${snapshotId}`,
        { method: "DELETE", headers: sessionBasic(session.sessionId, session.secret) },
      );
      expect(raw.status).toBe(403);
      // The route writes the refusal in the background (it does not hold the answer for it).
      const denied = await vi.waitFor(
        async () => {
          const rows = await fixture.db
            .select()
            .from(auditLog)
            .where(
              and(
                eq(auditLog.action, "endpoint.repository.denied"),
                sql`${auditLog.details}->>'recoveryId' = ${session.sessionId}`,
              ),
            );
          expect(rows.length).toBeGreaterThan(0);
          return rows;
        },
        { timeout: 10_000, interval: 100 },
      );
      expect(denied[0]?.details).toMatchObject({ principal: "recovery" });
      // The snapshot is still there.
      const listed = await restic(["snapshots", "--json"], agentEnv);
      expect(listed.out).toContain(snapshotId);
    }, 120_000);

    it("refuses a credential for another session than the one in the path", async () => {
      const one = await openSession();
      const two = await openSession();
      const crossed = await fetch(`${origin()}/agent/recovery/restic/${one.sessionId}/config`, {
        headers: sessionBasic(two.sessionId, two.secret),
      });
      expect(crossed.status).toBe(401);
      const wrongSecret = await fetch(`${origin()}/agent/recovery/restic/${one.sessionId}/config`, {
        headers: sessionBasic(one.sessionId, two.secret),
      });
      expect(wrongSecret.status).toBe(401);
    }, 120_000);

    it("ends the access with a cancel or a release", async () => {
      const cancelled = await openSession();
      const config = (session: Session) =>
        fetch(`${origin()}/agent/recovery/restic/${session.sessionId}/config`, {
          headers: sessionBasic(session.sessionId, session.secret),
        });
      expect((await config(cancelled)).status).toBe(200);
      await codes.cancelRecovery(
        shared.db,
        fixture.tenantId,
        endpointId,
        cancelled.sessionId,
        actor(),
      );
      const after = await config(cancelled);
      expect(after.status).toBe(401);
      expect(((await after.json()) as { title: string }).title).toBe("Credential expired");
      const released = await openSession();
      expect((await config(released)).status).toBe(200);
      const release = await fetch(`${origin()}/agent/v1/recovery/sessions/current/release`, {
        method: "POST",
        headers: {
          ...sessionBasic(released.sessionId, released.secret),
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(release.status).toBe(200);
      expect((await config(released)).status).toBe(401);
      const listed = await restic(["snapshots", "--no-lock", "--no-cache"], asIso(released));
      expect(listed.code).not.toBe(0);
    }, 120_000);

    it("keeps a session's state at most five seconds in another process", async () => {
      let loads = 0;
      const load = async () => {
        loads += 1;
        return null;
      };
      const id = "33333333-3333-4333-8333-333333333333";
      cache.forgetRecoverySession(id);
      const start = 1_000_000;
      await cache.cachedSessionAccess(id, start, load);
      await cache.cachedSessionAccess(id, start + 4999, load);
      expect(loads).toBe(1);
      await cache.cachedSessionAccess(id, start + 5000, load);
      expect(loads).toBe(2);
    });

    it("limits the requests of a session", async () => {
      const session = await openSession();
      const { SlidingWindowRateLimiter } = await import("../apikeys/rate-limit.js");
      const small = new SlidingWindowRateLimiter(2, 60_000);
      const credentials = { runId: session.sessionId, token: session.secret };
      const now = Date.now();
      for (let n = 0; n < 2; n++) {
        expect(
          (await route.resolveRecoveryCredential(credentials, session.sessionId, now, small)).ok,
        ).toBe(true);
      }
      await expect(
        route.resolveRecoveryCredential(credentials, session.sessionId, now, small),
      ).rejects.toMatchObject({ status: 429 });
      const { RECOVERY_RESTIC_LIMIT } = await import("./rate-limits.js");
      expect(RECOVERY_RESTIC_LIMIT).toBe(120_000);
    });
  },
);
