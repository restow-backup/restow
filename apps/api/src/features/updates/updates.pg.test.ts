/**
 * Postgres-backed tests of the Updates feature: the settings row that carries
 * the switch, the source and the channel, the access token sealed in the secret
 * store (never returned, logged or audited), the cached check, the daily
 * check's audit entry, the "update available" alert raised once per version
 * (the bell and the tenants' alert rules), the announcement of an update
 * through a scripted updater, and the updater's journal written to the audit
 * log exactly once.
 *
 * The services run on the installation role (BYPASSRLS), as the api process
 * does; tenants and rules are read back on the application role that Row Level
 * Security binds, to prove who sees what.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_updates_test` is recreated there and
 * dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes } from "node:crypto";
import {
  type Database,
  auditLog,
  createDb,
  notifications,
  providers,
  reportDeliveries,
  reportRules,
  secrets,
  settings,
  tenants,
} from "@restow/db";
import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  type ScheduleRequest,
  type StateView,
  idlePublicStatus,
  pendingSteps,
} from "../../updater/protocol.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { UpdaterClient } from "./updater-client.js";

const DATABASE = "restow_api_updates_test";
const TOKEN = "glpat-super-secret-token-0123456789";
const DIGEST = `sha256:${"c".repeat(64)}`;

type ServiceModule = typeof import("./service.js");
type StateModule = typeof import("./state.js");
type NotifyModule = typeof import("./notify.js");
type ReportsService = typeof import("../reports/service.js");

const actor = { id: "owner-1", email: "owner@provider.test", ip: "192.0.2.10" };

function githubReleases(...tags: { tag: string; prerelease?: boolean; body?: string }[]) {
  return tags.map((entry) => ({
    tag_name: entry.tag,
    name: `Release ${entry.tag}`,
    // A release of the project publishes the digest of its image (release.yml).
    body: entry.body ?? `Notes of ${entry.tag}\n\nrestow: ${DIGEST}`,
    draft: false,
    prerelease: entry.prerelease ?? false,
    html_url: `https://github.com/restow-backup/restow/releases/tag/${entry.tag}`,
    published_at: "2026-10-01T08:00:00Z",
  }));
}

/** A scripted release server: answers per URL prefix and records every request. */
class ScriptedFeed {
  readonly requests: { url: string; headers: Record<string, string> }[] = [];
  answer: () => Response = () => new Response("[]", { status: 200 });
  /** When set, answers wait for it: a check that is still running. */
  gate: Promise<void> | null = null;

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    this.requests.push({ url: input, headers: { ...(init?.headers as Record<string, string>) } });
    await this.gate;
    return this.answer();
  };

  respondWith(body: unknown, status = 200) {
    this.answer = () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
  }
}

function capabilities(over: Partial<StateView["capabilities"]> = {}): StateView["capabilities"] {
  return {
    ready: true,
    blockers: [],
    runner: "helper",
    composeFile: "/srv/restow/docker-compose.yml",
    imageRepository: "ghcr.io/restow-backup/restow",
    webImageRepository: "ghcr.io/restow-backup/restow-web",
    dumps: [],
    sourceAllowlist: [],
    signatureChecks: true,
    checkedAt: "2026-10-01T09:00:00.000Z",
    ...over,
  };
}

function idleState(over: Partial<StateView> = {}): StateView {
  return {
    updaterVersion: "0.1.0",
    phase: "idle",
    run: null,
    history: [],
    events: [],
    capabilities: capabilities(),
    selfUpdate: null,
    serverTime: "2026-10-01T09:00:00.000Z",
    ...over,
  };
}

class ScriptedUpdater implements UpdaterClient {
  enabled = true;
  view: StateView | null = idleState();
  readonly scheduled: ScheduleRequest[] = [];
  cancelled = 0;
  acknowledged = 0;

  async state() {
    return this.view;
  }

  async schedule(request: ScheduleRequest) {
    this.scheduled.push(request);
    const startsAt = new Date(Date.parse("2026-10-01T09:00:00.000Z") + request.leadSeconds * 1000);
    this.view = idleState({
      phase: "scheduled",
      run: {
        id: "r-1",
        mode: request.mode,
        switchTo: request.switchTo,
        fromVersion: "0.1.0",
        targetVersion: request.release.version,
        targetTag: request.release.tag,
        releaseUrl: request.release.url,
        requestedBy: request.requestedBy,
        scheduledAt: "2026-10-01T09:00:00.000Z",
        leadSeconds: request.leadSeconds,
        startsAt: startsAt.toISOString(),
        startedAt: null,
        finishedAt: null,
        cancelledAt: null,
        outcome: null,
        step: null,
        steps: pendingSteps(),
        progress: 0,
        message: null,
        failure: null,
        recovery: null,
        images: { app: null, web: null },
        digestVerified: null,
        signatureVerified: null,
        log: [],
        cancelled: false,
      },
    });
    return this.view;
  }

  async cancel() {
    this.cancelled += 1;
    this.view = idleState();
    return this.view;
  }

  async acknowledge() {
    this.acknowledged += 1;
    this.view = idleState();
    return this.view;
  }
}

describe.skipIf(!testDatabaseAdminUrl)("updates against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let serviceModule: ServiceModule;
  let stateModule: StateModule;
  let notifyModule: NotifyModule;
  let reports: ReportsService;
  let contoso: string;
  let fabrikam: string;
  const feed = new ScriptedFeed();
  let updater: ScriptedUpdater;
  let now: Date;
  let running: string | null;
  // The audit log is append-only, so each case reads only what it wrote itself.
  let since: Date;

  function build(env: Record<string, string | undefined> = {}, demo = false) {
    const state = new stateModule.UpdateStateCache(running, env.RESTOW_UPDATE_CHECK_URL);
    const service = new serviceModule.UpdateService({
      db: providerDb,
      state,
      updater,
      env,
      demo,
      fetch: feed.fetch,
      now: () => now,
    });
    return { state, service };
  }

  const auditRows = (action: string) =>
    owner
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, action), isNull(auditLog.tenantId), gte(auditLog.createdAt, since)),
      )
      .orderBy(asc(auditLog.createdAt));

  const row = async () => {
    const [current] = await owner.select().from(settings);
    if (!current) {
      throw new Error("no settings row");
    }
    return current;
  };

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    providerDb = createDb(roles.providerUrl);

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const created = await owner
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
      ])
      .returning();
    contoso = created[0]?.id ?? "";
    fabrikam = created[1]?.id ?? "";

    serviceModule = await import("./service.js");
    stateModule = await import("./state.js");
    notifyModule = await import("./notify.js");
    reports = await import("../reports/service.js");
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await Promise.all([owner?.$client.end(), appDb?.$client.end(), providerDb?.$client.end()]);
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  beforeEach(async () => {
    // The audit chain keeps createdAt strictly increasing (nextCreatedAt bumps a row to the
    // previous one + 1 ms), so the last row of the case before can sit slightly in the future.
    // Start the window after it, or that row leaks into this case's reads.
    const [latest] = await owner
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    const afterLatest = latest ? latest.createdAt.getTime() + 1 : 0;
    since = new Date(Math.max(Date.now(), afterLatest));
    // Every case starts from a fresh installation: settings row, no token, no cache, empty outbox.
    await owner.delete(reportDeliveries);
    await owner.delete(reportRules);
    await owner.delete(notifications);
    await owner.delete(secrets);
    await owner.delete(settings);
    await owner.insert(settings).values({
      singleton: true,
      operatingMode: "public",
      publicUrl: "https://restow.example.com",
    });
    updater = new ScriptedUpdater();
    now = new Date("2026-10-01T09:00:00.000Z");
    running = "0.1.0";
    feed.requests.length = 0;
    feed.respondWith(githubReleases({ tag: "v0.2.0" }, { tag: "v0.1.0" }));
  });

  describe("the settings", () => {
    it("start with the check off, the default source and no token", async () => {
      const { service } = build();
      const view = await service.view();
      expect(view).toMatchObject({
        running: "0.1.0",
        demo: false,
        settings: { enabled: false, channel: "stable", sourceUrl: null, tokenSet: false },
        environmentOverride: null,
        source: {
          origin: "default",
          url: "https://github.com/restow-backup/restow",
          provider: "github",
          repository: "restow-backup/restow",
          isDefault: true,
        },
        mode: "image",
        sourceAllowed: true,
        check: {
          enabled: false,
          state: "disabled",
          checkedAt: null,
          nextCheckAt: null,
          error: null,
        },
        latest: null,
        updateAvailable: null,
        releases: [],
        updater: { state: "ready" },
      });
      expect(feed.requests).toEqual([]);
    });

    it("persist the switch, the source and the channel, and audit the change", async () => {
      const { service } = build();
      const before = await row();
      const view = await service.saveSettings(
        { enabled: true, channel: "beta", sourceUrl: "https://git.example.com/acme/restow" },
        actor,
      );
      const stored = await row();
      expect(stored).toMatchObject({
        updateCheckEnabled: true,
        updateChannel: "beta",
        updateSourceUrl: "https://git.example.com/acme/restow",
      });
      // (The clocks of the test host and the database container may differ a little, so
      // compare for a change, not for an order.)
      expect(stored.updatedAt.getTime()).not.toBe(before.updatedAt.getTime());
      expect(view).toMatchObject({
        settings: {
          enabled: true,
          channel: "beta",
          sourceUrl: "https://git.example.com/acme/restow",
        },
        source: {
          origin: "settings",
          provider: "forgejo",
          repository: "acme/restow",
          isDefault: false,
        },
        mode: "source",
        // The updater's environment names no source: it would not build from this one.
        sourceAllowed: false,
      });
      const [entry] = await auditRows("update.settings.updated");
      expect(entry).toMatchObject({
        actor: "owner@provider.test",
        actorUserId: "owner-1",
        ip: "192.0.2.10",
        target: "update",
        targetType: "settings",
      });
      expect(entry?.details).toMatchObject({
        changed: ["enabled", "channel", "source"],
        enabled: true,
        channel: "beta",
        source: "https://git.example.com/acme/restow",
        tokenAction: null,
      });
    });

    it("read back the same in a new process", async () => {
      const first = build();
      await first.service.saveSettings({ enabled: true, channel: "beta" }, actor);
      const second = build();
      const view = await second.service.view();
      expect(view.settings).toMatchObject({ enabled: true, channel: "beta" });
      expect(second.state.current().channel).toBe("beta");
    });

    it("keep the default source out of the stored column", async () => {
      const { service } = build();
      await service.saveSettings({ sourceUrl: "https://git.example.com/acme/restow" }, actor);
      await service.saveSettings(
        { sourceUrl: "https://github.com/RESTOW-BACKUP/restow.git" },
        actor,
      );
      expect((await row()).updateSourceUrl).toBeNull();
      await service.saveSettings({ sourceUrl: "https://git.example.com/acme/restow" }, actor);
      await service.saveSettings({ sourceUrl: null }, actor);
      expect((await row()).updateSourceUrl).toBeNull();
    });

    it("refuse a source that is not a repository over https, leaving everything as it was", async () => {
      const { service } = build();
      for (const sourceUrl of [
        "http://github.com/acme/restow",
        "https://user:pw@git.example.com/acme/restow",
        "https://git.example.com/onlyone",
        "nonsense",
      ]) {
        await expect(service.saveSettings({ sourceUrl }, actor)).rejects.toMatchObject({
          status: 422,
          extensions: { field: "sourceUrl" },
        });
      }
      expect((await row()).updateSourceUrl).toBeNull();
      expect(await auditRows("update.settings.updated")).toHaveLength(0);
    });

    it("refuse an address on this server's own networks unless the operator listed the host", async () => {
      const { service } = build();
      for (const sourceUrl of [
        "https://10.0.0.5/acme/restow",
        "https://169.254.169.254/acme/restow",
        "https://localhost/acme/restow",
        "https://gitea/acme/restow",
        "https://git.corp.local/acme/restow",
      ]) {
        await expect(service.saveSettings({ sourceUrl }, actor), sourceUrl).rejects.toMatchObject({
          status: 422,
          type: "urn:restow:problem:invalid-update-source",
          extensions: { field: "sourceUrl", code: "private_address" },
        });
      }
      expect((await row()).updateSourceUrl).toBeNull();
      const listed = build({ RESTOW_UPDATER_SOURCE_HOSTS: "gitea" });
      await listed.service.saveSettings({ sourceUrl: "https://gitea/acme/restow" }, actor);
      expect((await row()).updateSourceUrl).toBe("https://gitea/acme/restow");
    });

    it("audit nothing when nothing changed", async () => {
      const { service } = build();
      await service.saveSettings({ channel: "stable" }, actor);
      expect(await auditRows("update.settings.updated")).toHaveLength(0);
    });

    it("cannot change the source, the switch or the token while the environment decides", async () => {
      const { service } = build({
        RESTOW_UPDATE_CHECK_URL: "https://api.github.com/repos/acme/restow/releases",
      });
      await expect(service.saveSettings({ enabled: true }, actor)).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:update-settings-overridden",
      });
      await expect(service.saveSettings({ token: "x" }, actor)).rejects.toMatchObject({
        status: 409,
      });
      // The channel is still the administrator's.
      const view = await service.saveSettings({ channel: "beta" }, actor);
      expect(view.settings.channel).toBe("beta");
      expect(view.environmentOverride).toEqual({
        url: "https://api.github.com/repos/acme/restow/releases",
      });
      expect(view.source.origin).toBe("environment");
      expect(view.check.enabled).toBe(true);
    });
  });

  describe("the access token", () => {
    const repo = "https://git.example.com/acme/restow";

    it("is sealed in the secret store and never returned, logged or audited", async () => {
      const { service } = build();
      const view = await service.saveSettings({ sourceUrl: repo, token: TOKEN }, actor);
      expect(view.settings.tokenSet).toBe(true);
      expect(JSON.stringify(view)).not.toContain(TOKEN);

      const stored = await owner
        .select()
        .from(secrets)
        .where(eq(secrets.kind, "update_source_token"));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.tenantId).toBeNull();
      expect(stored[0]?.ciphertext).not.toContain(TOKEN);
      expect(Buffer.from(stored[0]?.ciphertext ?? "", "base64").toString("latin1")).not.toContain(
        TOKEN,
      );

      const entries = await owner.select().from(auditLog).where(gte(auditLog.createdAt, since));
      expect(JSON.stringify(entries)).not.toContain(TOKEN);
      const [entry] = await auditRows("update.settings.updated");
      expect(entry?.details).toMatchObject({ changed: ["source", "token"], tokenAction: "set" });
      // The settings row itself holds no token.
      expect(JSON.stringify(await row())).not.toContain(TOKEN);
    });

    it("is sent to its own origin with the check, as a header, and nowhere else", async () => {
      const { service } = build();
      await service.saveSettings({ sourceUrl: repo, token: TOKEN, enabled: true }, actor);
      const request = feed.requests[0];
      expect(request?.url).toBe(
        "https://git.example.com/api/v1/repos/acme/restow/releases?limit=30",
      );
      expect(request?.url).not.toContain(TOKEN);
      expect(request?.headers.authorization).toBe(`token ${TOKEN}`);
    });

    it("can be replaced and removed, with the reason audited", async () => {
      const { service } = build();
      await service.saveSettings({ sourceUrl: repo, token: TOKEN }, actor);
      await service.saveSettings({ token: "another-token-value" }, actor);
      expect(
        await owner.select().from(secrets).where(eq(secrets.kind, "update_source_token")),
      ).toHaveLength(1);
      const view = await service.saveSettings({ token: null }, actor);
      expect(view.settings.tokenSet).toBe(false);
      expect(
        await owner.select().from(secrets).where(eq(secrets.kind, "update_source_token")),
      ).toHaveLength(0);
      const actions = (await auditRows("update.settings.updated")).map(
        (entry) => (entry.details as { tokenAction: string | null }).tokenAction,
      );
      expect(actions).toEqual(["set", "replaced", "removed"]);
    });

    it("is dropped when the source moves to another origin, instead of following it there", async () => {
      const { service } = build();
      await service.saveSettings({ sourceUrl: repo, token: TOKEN, enabled: true }, actor);
      const view = await service.saveSettings(
        { sourceUrl: "https://other.example.org/acme/restow" },
        actor,
      );
      expect(view.settings.tokenSet).toBe(false);
      const entries = await auditRows("update.settings.updated");
      expect((entries.at(-1)?.details as { tokenAction: string }).tokenAction).toBe(
        "removed_source_changed",
      );
      const last = feed.requests.at(-1);
      expect(last?.url.startsWith("https://other.example.org/")).toBe(true);
      expect(last?.headers.authorization).toBeUndefined();
    });

    it("stays when the path changes on the same origin", async () => {
      const { service } = build();
      await service.saveSettings({ sourceUrl: repo, token: TOKEN }, actor);
      const view = await service.saveSettings(
        { sourceUrl: "https://git.example.com/acme/restow-next" },
        actor,
      );
      expect(view.settings.tokenSet).toBe(true);
    });

    it("is never sent to an environment override", async () => {
      const first = build();
      await first.service.saveSettings({ sourceUrl: repo, token: TOKEN }, actor);
      feed.requests.length = 0;
      const { service } = build({
        RESTOW_UPDATE_CHECK_URL: "https://api.github.com/repos/acme/restow/releases",
      });
      await service.checkNow(actor);
      expect(feed.requests[0]?.headers.authorization).toBeUndefined();
    });

    it("cannot be stored for a feed that is not a repository", async () => {
      const { service } = build({ RESTOW_UPDATE_CHECK_URL: undefined });
      await expect(
        service.saveSettings({ sourceUrl: "https://example.com/onlyone", token: TOKEN }, actor),
      ).rejects.toBeInstanceOf(ProblemError);
    });
  });

  describe("the check", () => {
    it("stores the releases of the channel, audits itself and reports an update", async () => {
      const { service, state } = build();
      const view = await service.saveSettings({ enabled: true }, actor);
      // Enabling looks once at the source at once.
      expect(feed.requests).toHaveLength(1);
      expect(view.check).toMatchObject({
        enabled: true,
        state: "ok",
        checkedAt: "2026-10-01T09:00:00.000Z",
        nextCheckAt: "2026-10-02T09:00:00.000Z",
        error: null,
      });
      expect(view.latest).toMatchObject({
        version: "0.2.0",
        tag: "v0.2.0",
        prerelease: false,
        url: "https://github.com/restow-backup/restow/releases/tag/v0.2.0",
      });
      expect(view.updateAvailable).toBe(true);
      expect(view.releases.map((release) => release.version)).toEqual(["0.2.0"]);
      expect(state.current()).toMatchObject({ latest: "0.2.0", updateAvailable: true });
      const stored = (await row()).updateCheck;
      expect(stored).toMatchObject({
        state: "ok",
        channel: "stable",
        lastOkAt: "2026-10-01T09:00:00.000Z",
      });

      const [entry] = await auditRows("update.check");
      expect(entry).toMatchObject({
        target: "0.2.0",
        targetType: "update",
        actor: "owner@provider.test",
      });
      expect(entry?.details).toMatchObject({
        trigger: "manual",
        state: "ok",
        latest: "0.2.0",
        running: "0.1.0",
        errorCode: null,
      });
    });

    it("reads only the release list: no body and no data about the installation", async () => {
      const { service } = build();
      await service.saveSettings({ enabled: true }, actor);
      expect(feed.requests[0]?.url).toBe(
        "https://api.github.com/repos/restow-backup/restow/releases?per_page=30",
      );
      expect(JSON.stringify(feed.requests)).not.toContain("restow.example.com");
    });

    it("cannot run while the switch is off", async () => {
      const { service } = build();
      await expect(service.checkNow(actor)).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:update-check-disabled",
      });
      expect(feed.requests).toEqual([]);
    });

    it("keeps the last good releases and says why a later check failed", async () => {
      const { service } = build();
      await service.saveSettings({ enabled: true }, actor);
      now = new Date("2026-10-02T09:30:00.000Z");
      feed.respondWith({ message: "API rate limit exceeded" }, 403);
      feed.answer = () =>
        new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790934000" },
        });
      const view = await service.checkNow(actor);
      expect(view.check).toMatchObject({
        state: "failed",
        checkedAt: "2026-10-02T09:30:00.000Z",
        error: { code: "rate_limited", status: 403 },
      });
      expect(view.latest?.version).toBe("0.2.0");
      expect(view.updateAvailable).toBe(true);
      const stored = (await row()).updateCheck;
      expect(stored?.lastOkAt).toBe("2026-10-01T09:00:00.000Z");
      const entries = await auditRows("update.check");
      expect(entries.at(-1)?.details).toMatchObject({ state: "failed", errorCode: "rate_limited" });
    });

    it("forgets the releases of another source or channel", async () => {
      const { service } = build();
      await service.saveSettings({ enabled: true }, actor);
      expect((await row()).updateCheck).not.toBeNull();
      feed.respondWith(githubReleases({ tag: "v0.3.0-rc.1", prerelease: true }, { tag: "v0.2.0" }));
      const view = await service.saveSettings({ channel: "beta" }, actor);
      expect(view.latest?.version).toBe("0.3.0-rc.1");
      expect(view.latest?.prerelease).toBe(true);
      const failing = await service.saveSettings(
        { sourceUrl: "https://git.example.com/acme/restow" },
        actor,
      );
      // The new source answered with the same scripted list, but it is its own result.
      expect(failing.check.state).toBe("ok");
    });

    it("stable does not offer pre-releases", async () => {
      feed.respondWith(githubReleases({ tag: "v0.3.0-rc.1", prerelease: true }, { tag: "v0.2.0" }));
      const { service } = build();
      const view = await service.saveSettings({ enabled: true }, actor);
      expect(view.latest?.version).toBe("0.2.0");
      expect(view.releases.map((release) => release.version)).toEqual(["0.2.0"]);
    });

    it("runs the scheduled check once a day, not before", async () => {
      const { service } = build();
      await service.saveSettings({ enabled: true }, actor);
      const requests = feed.requests.length;
      now = new Date("2026-10-02T08:59:00.000Z");
      await service.runScheduledCheckIfDue();
      expect(feed.requests).toHaveLength(requests);
      now = new Date("2026-10-02T09:00:01.000Z");
      await service.runScheduledCheckIfDue();
      expect(feed.requests).toHaveLength(requests + 1);
      const entries = await auditRows("update.check");
      expect(entries.at(-1)).toMatchObject({ actor: "system", actorUserId: null });
      expect(entries.at(-1)?.details).toMatchObject({ trigger: "scheduled" });
    });

    it("retries a failed check after an hour, not sooner", async () => {
      feed.answer = () => new Response("", { status: 503 });
      const { service } = build();
      await service.saveSettings({ enabled: true }, actor);
      const requests = feed.requests.length;
      now = new Date("2026-10-01T09:30:00.000Z");
      await service.runScheduledCheckIfDue();
      expect(feed.requests).toHaveLength(requests);
      now = new Date("2026-10-01T10:01:00.000Z");
      await service.runScheduledCheckIfDue();
      expect(feed.requests).toHaveLength(requests + 1);
    });

    it("never contacts anything when the check is off or in demo mode", async () => {
      const off = build();
      await off.service.runScheduledCheckIfDue();
      const demo = build({}, true);
      await demo.service.runScheduledCheckIfDue();
      expect(feed.requests).toEqual([]);
      const view = await demo.service.view();
      expect(view.demo).toBe(true);
      expect(view.updater.state).toBe("demo");
      expect(view.check.enabled).toBe(false);
    });

    it("never runs two checks at the same moment", async () => {
      const { service } = build();
      await service.saveSettings({ enabled: true }, actor);
      const requests = feed.requests.length;
      let release = () => {};
      feed.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const both = Promise.all([service.checkNow(actor), service.checkNow(actor)]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      release();
      await both;
      feed.gate = null;
      expect(feed.requests.length - requests).toBe(1);
    });

    it("does not touch the time the settings last changed", async () => {
      const { service } = build();
      await service.saveSettings({ enabled: true }, actor);
      const before = (await row()).updatedAt.getTime();
      await service.checkNow(actor);
      expect((await row()).updatedAt.getTime()).toBe(before);
    });
  });

  describe("the update-available alert", () => {
    async function ruleFor(tenantId: string, over: Partial<typeof reportRules.$inferInsert> = {}) {
      const [rule] = await owner
        .insert(reportRules)
        .values({
          tenantId,
          name: "Updates",
          trigger: "event",
          events: ["update.available"],
          emailRecipients: ["ops@example.com"],
          ...over,
        })
        .returning();
      return rule;
    }

    const bell = async () =>
      owner.select().from(notifications).where(eq(notifications.event, "update.available"));

    it("is raised once per new version, in the bell and in every tenant's matching rule", async () => {
      await ruleFor(contoso);
      await ruleFor(fabrikam, { emailRecipients: ["a@example.com", "b@example.com"] });
      await ruleFor(fabrikam, { name: "Disabled", enabled: false });
      await ruleFor(contoso, { name: "Other event", events: ["backup.failed"] });
      const { service } = build();
      await service.saveSettings({ enabled: true }, actor);

      const items = await bell();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ tenantId: null, level: "info" });
      expect(items[0]?.details).toMatchObject({
        version: "0.2.0",
        tag: "v0.2.0",
        running: "0.1.0",
      });
      const deliveries = await owner.select().from(reportDeliveries);
      expect(deliveries).toHaveLength(3);
      expect(new Set(deliveries.map((delivery) => delivery.subjectKey))).toEqual(
        new Set(["update:0.2.0"]),
      );
      expect(deliveries.every((delivery) => delivery.event === "update.available")).toBe(true);
      expect(deliveries.filter((delivery) => delivery.tenantId === fabrikam)).toHaveLength(2);
      expect(deliveries[0]?.payload).toMatchObject({
        event: "update.available",
        details: { version: "0.2.0", objectName: "0.2.0" },
      });
      expect((await row()).updateNotifiedVersion).toBe("0.2.0");

      // Checking again, by hand or on schedule, does not raise it again.
      await service.checkNow(actor);
      now = new Date("2026-10-02T10:00:00.000Z");
      await service.runScheduledCheckIfDue();
      expect(await bell()).toHaveLength(1);
      expect(await owner.select().from(reportDeliveries)).toHaveLength(3);

      // A newer version is a new alert; an older or equal one never is.
      feed.respondWith(githubReleases({ tag: "v0.3.0" }, { tag: "v0.2.0" }));
      await service.checkNow(actor);
      expect(await bell()).toHaveLength(2);
      feed.respondWith(githubReleases({ tag: "v0.2.5" }));
      await service.checkNow(actor);
      expect(await bell()).toHaveLength(2);
    });

    it("is not raised when the installation is up to date", async () => {
      running = "0.2.0";
      const { service } = build();
      await service.saveSettings({ enabled: true }, actor);
      expect(await bell()).toHaveLength(0);
    });

    it("skips rules of tenants that are not active", async () => {
      await ruleFor(contoso);
      await owner.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, contoso));
      const { service } = build();
      await service.saveSettings({ enabled: true }, actor);
      expect(await owner.select().from(reportDeliveries)).toHaveLength(0);
      await owner.update(tenants).set({ status: "active" }).where(eq(tenants.id, contoso));
    });

    it("is claimed by one process only when two raise it at the same moment", async () => {
      const release = { version: "0.2.0", tag: "v0.2.0", url: null, publishedAt: null };
      await ruleFor(contoso);
      const outcomes = await Promise.all([
        notifyModule.raiseUpdateAvailable(providerDb, { release, running: "0.1.0" }),
        notifyModule.raiseUpdateAvailable(providerDb, { release, running: "0.1.0" }),
      ]);
      expect(outcomes.sort()).toEqual(["already_notified", "raised"]);
      expect(await bell()).toHaveLength(1);
      expect(await owner.select().from(reportDeliveries)).toHaveLength(1);
    });

    it("shows in a provider administrator's bell, but not in a tenant administrator's", async () => {
      const { service } = build();
      await service.saveSettings({ enabled: true }, actor);
      const tenantBell = await reports.listNotifications(appDb, contoso);
      expect(tenantBell.items).toHaveLength(0);
      const providerBell = await reports.listNotifications(appDb, contoso, {
        installation: providerDb,
      });
      expect(providerBell.items.map((item) => item.event)).toEqual(["update.available"]);
      expect(providerBell.items[0]).toMatchObject({ tenantId: null, read: false });
      expect(providerBell.unread).toBe(1);
      // "An update is available" is information; the bell stays neutral for it.
      expect(providerBell.unreadAttention).toBe(0);
      const marked = await reports.markNotificationsRead(appDb, contoso, { all: true }, now, {
        installation: providerDb,
      });
      expect(marked.updated).toBe(1);
      expect(
        (await reports.listNotifications(appDb, contoso, { installation: providerDb })).unread,
      ).toBe(0);
    });

    it("can be put into a rule by a provider administrator only", async () => {
      const providerCatalog = await reports.reportCatalog(appDb, { providerAdmin: true });
      const tenantCatalog = await reports.reportCatalog(appDb, { providerAdmin: false });
      expect(providerCatalog.events.map((event) => event.name)).toContain("update.available");
      expect(tenantCatalog.events.map((event) => event.name)).not.toContain("update.available");

      const input = {
        trigger: "event" as const,
        name: "Updates",
        enabled: true,
        events: ["update.available" as const],
        throttleMinutes: 60,
        timezone: "UTC",
        periodDays: 7,
        sections: [],
        emailRecipients: ["ops@example.com"],
        inApp: false,
        webhookId: null,
        language: null,
      };
      const tenantAdmin = { userId: "t1", label: "admin@contoso.example", ip: null };
      await expect(
        reports.createRule(appDb, contoso, input, tenantAdmin, now),
      ).rejects.toMatchObject({
        status: 422,
      });
      const created = await reports.createRule(
        appDb,
        contoso,
        input,
        { ...tenantAdmin, providerAdmin: true },
        now,
      );
      expect(created.events).toEqual(["update.available"]);

      // A tenant administrator saving the rule does not silently drop the installation event,
      // and saving it as their editor sends it back (with the event) is fine too.
      const edited = await reports.updateRule(
        appDb,
        contoso,
        created.id,
        { events: ["backup.failed"], name: "Renamed" },
        tenantAdmin,
        now,
      );
      expect(edited.events.sort()).toEqual(["backup.failed", "update.available"]);
      const resent = await reports.updateRule(
        appDb,
        contoso,
        created.id,
        { events: ["backup.failed", "update.available"] },
        tenantAdmin,
        now,
      );
      expect(resent.events.sort()).toEqual(["backup.failed", "update.available"]);

      // Adding it to a rule that does not have it is a provider administrator's decision.
      const plain = await reports.createRule(
        appDb,
        contoso,
        { ...input, name: "Plain", events: ["backup.failed" as const] },
        tenantAdmin,
        now,
      );
      await expect(
        reports.updateRule(
          appDb,
          contoso,
          plain.id,
          { events: ["backup.failed", "update.available"] },
          tenantAdmin,
          now,
        ),
      ).rejects.toMatchObject({ status: 422 });
    });
  });

  describe("announcing an update", () => {
    async function withCheck(env: Record<string, string | undefined> = {}) {
      const built = build(env);
      if (env.RESTOW_UPDATE_CHECK_URL) {
        // The environment turns the check on by itself; the tab cannot.
        await built.service.checkNow(actor);
      } else {
        await built.service.saveSettings({ enabled: true }, actor);
      }
      return built;
    }

    it("hands the updater an image update of the public release, and audits it", async () => {
      feed.respondWith(githubReleases({ tag: "v0.2.0", body: `notes\nrestow: ${DIGEST}` }));
      const { service } = await withCheck();
      const view = await service.schedule({ version: "0.2.0", leadSeconds: 300 }, actor);
      expect(updater.scheduled).toHaveLength(1);
      expect(updater.scheduled[0]).toEqual({
        release: {
          version: "0.2.0",
          tag: "v0.2.0",
          url: "https://github.com/restow-backup/restow/releases/tag/v0.2.0",
          prerelease: false,
          digests: { app: DIGEST },
        },
        mode: "image",
        switchTo: null,
        source: null,
        leadSeconds: 300,
        requestedBy: { userId: "owner-1", label: "owner@provider.test", ip: "192.0.2.10" },
      });
      expect(view.maintenance).toMatchObject({ phase: "scheduled", targetVersion: "0.2.0" });
      expect(view.updater.state).toBe("busy");
      const [entry] = await auditRows("update.scheduled");
      expect(entry).toMatchObject({
        target: "0.2.0",
        targetType: "update",
        actor: "owner@provider.test",
      });
      expect(entry?.details).toMatchObject({
        version: "0.2.0",
        from: "0.1.0",
        mode: "image",
        leadSeconds: 300,
        runId: "r-1",
        digestPublished: true,
      });
    });

    it("refuses an image update of a release that publishes no digest, before asking the updater", async () => {
      feed.respondWith(githubReleases({ tag: "v0.2.0", body: "notes without digests" }));
      const { service } = await withCheck();
      await expect(
        service.schedule({ version: "0.2.0", leadSeconds: 0 }, actor),
      ).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:update-not-verifiable",
      });
      expect(updater.scheduled).toEqual([]);
      expect(await auditRows("update.scheduled")).toHaveLength(0);
    });

    it("builds from source for a custom repository and passes the tag archive, never the token", async () => {
      updater.view = idleState({
        capabilities: capabilities({ sourceAllowlist: ["git.example.com/acme/restow"] }),
      });
      const first = build();
      await first.service.saveSettings(
        { sourceUrl: "https://git.example.com/acme/restow", token: TOKEN },
        actor,
      );
      const { service } = await withCheck();
      await service.schedule({ version: "0.2.0", leadSeconds: 0 }, actor);
      const request = updater.scheduled[0];
      expect(request?.mode).toBe("source");
      expect(request?.source).toEqual({
        archiveUrl: "https://git.example.com/api/v1/repos/acme/restow/archive/v0.2.0.tar.gz",
        repository: "acme/restow",
        useToken: true,
      });
      expect(JSON.stringify(request)).not.toContain(TOKEN);
    });

    it("refuses a repository the operator did not allow on the updater, before asking it", async () => {
      const first = build();
      await first.service.saveSettings({ sourceUrl: "https://git.example.com/acme/restow" }, actor);
      for (const allowlist of [[], ["git.example.com/acme/other"], ["github.com/acme/restow"]]) {
        updater.view = idleState({ capabilities: capabilities({ sourceAllowlist: allowlist }) });
        const { service } = await withCheck();
        expect((await service.view()).sourceAllowed).toBe(false);
        await expect(
          service.schedule({ version: "0.2.0", leadSeconds: 0 }, actor),
        ).rejects.toMatchObject({
          status: 409,
          type: "urn:restow:problem:update-source-not-allowed",
        });
      }
      updater.view = idleState({
        capabilities: capabilities({ sourceAllowlist: ["git.example.com"] }),
      });
      expect((await build().service.view()).sourceAllowed).toBe(true);
      expect(updater.scheduled).toEqual([]);
      expect(await auditRows("update.scheduled")).toHaveLength(0);
    });

    it("cannot build from a feed that has no repository behind it", async () => {
      const { service } = await withCheck({
        RESTOW_UPDATE_CHECK_URL: "https://example.com/releases.json",
      });
      await expect(
        service.schedule({ version: "0.2.0", leadSeconds: 0 }, actor),
      ).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:update-source-unsupported",
      });
      expect(updater.scheduled).toEqual([]);
    });

    it("refuses a version that is not among the newer releases of the last check", async () => {
      const { service } = await withCheck();
      for (const version of ["0.1.0", "9.9.9", "0.2.0-rc.1"]) {
        await expect(service.schedule({ version, leadSeconds: 0 }, actor)).rejects.toMatchObject({
          status: 422,
          type: "urn:restow:problem:update-version-unknown",
        });
      }
      expect(updater.scheduled).toEqual([]);
    });

    it("refuses when the running version is unknown", async () => {
      running = null;
      const { service } = await withCheck();
      await expect(
        service.schedule({ version: "0.2.0", leadSeconds: 0 }, actor),
      ).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:update-running-unknown",
      });
    });

    it("says plainly when no updater runs, when it is blocked and when it is busy", async () => {
      const { service } = await withCheck();
      updater.view = null;
      await expect(
        service.schedule({ version: "0.2.0", leadSeconds: 0 }, actor),
      ).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:updater-unavailable",
      });
      updater.view = idleState({
        capabilities: capabilities({
          ready: false,
          blockers: [{ code: "compose_missing", detail: null }],
        }),
      });
      await expect(
        service.schedule({ version: "0.2.0", leadSeconds: 0 }, actor),
      ).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:updater-blocked",
        extensions: { blockers: [{ code: "compose_missing", detail: null }] },
      });
      const view = await service.view();
      expect(view.updater).toMatchObject({
        state: "blocked",
        blockers: [{ code: "compose_missing" }],
      });
      updater.view = idleState({ phase: "running" });
      await expect(
        service.schedule({ version: "0.2.0", leadSeconds: 0 }, actor),
      ).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:update-busy",
      });
      expect(await auditRows("update.scheduled")).toHaveLength(0);
    });

    it("cannot be announced in the demo", async () => {
      const { service } = build({}, true);
      await expect(
        service.schedule({ version: "0.2.0", leadSeconds: 0 }, actor),
      ).rejects.toMatchObject({
        status: 403,
      });
      expect(updater.scheduled).toEqual([]);
    });

    it("can be cancelled and acknowledged, each audited", async () => {
      const { service } = await withCheck();
      await service.schedule({ version: "0.2.0", leadSeconds: 900 }, actor);
      const view = await service.cancel(actor);
      expect(updater.cancelled).toBe(1);
      expect(view.maintenance.phase).toBe("idle");
      const [cancelled] = await auditRows("update.cancelled");
      expect(cancelled).toMatchObject({ target: "0.2.0", actor: "owner@provider.test" });
      expect(cancelled?.details).toMatchObject({ runId: "r-1" });
      await service.dismiss(actor);
      expect(updater.acknowledged).toBe(1);
      expect(await auditRows("update.acknowledged")).toHaveLength(1);
    });

    it("shows every signed-in user the same, small maintenance document", async () => {
      const { service } = await withCheck();
      // Signed-in users see the versions; the public status of the edge does not.
      expect(await service.maintenance()).toEqual({
        ...idlePublicStatus(now),
        targetVersion: null,
        fromVersion: null,
        runningVersion: "0.1.0",
        switchTo: null,
      });
      await service.schedule({ version: "0.2.0", leadSeconds: 300 }, actor);
      const view = await service.maintenance();
      expect(view).toMatchObject({
        phase: "scheduled",
        targetVersion: "0.2.0",
        fromVersion: "0.1.0",
        startsAt: "2026-10-01T09:05:00.000Z",
        runningVersion: "0.1.0",
      });
      // Nothing an outsider should not learn: no requester, no images, no log.
      expect(Object.keys(view).sort()).toEqual(
        [
          "failureCode",
          "finishedAt",
          "fromVersion",
          "message",
          "outcome",
          "phase",
          "progress",
          "runId",
          "runningVersion",
          "serverTime",
          "startedAt",
          "startsAt",
          "step",
          "steps",
          "switchTo",
          "targetVersion",
        ].sort(),
      );
    });

    it("says the version document carries the announced maintenance for integrations", async () => {
      const { service, state } = await withCheck();
      await service.schedule({ version: "0.2.0", leadSeconds: 60 }, actor);
      expect(state.current().maintenance).toEqual({
        phase: "scheduled",
        targetVersion: "0.2.0",
        startsAt: "2026-10-01T09:01:00.000Z",
      });
    });
  });

  describe("the Community build", () => {
    const COMMUNITY = { RESTOW_IMAGE_VARIANT: "community" };
    const FULL_APP = `sha256:${"a".repeat(64)}`;
    const FULL_WEB = `sha256:${"b".repeat(64)}`;
    const notes = `notes\nrestow-community: ${DIGEST}\nrestow: ${FULL_APP}\nrestow-web: ${FULL_WEB}`;

    it("names the full images of the running version for a switch by hand", async () => {
      const { service } = build(COMMUNITY);
      const view = await service.view();
      expect(view.edition).toEqual({
        build: "community",
        pendingLicenseKey: false,
        fullImages: {
          app: "ghcr.io/restow-backup/restow:0.1.0",
          web: "ghcr.io/restow-backup/restow-web:0.1.0",
        },
      });
      expect((await build().service.view()).edition).toMatchObject({
        build: "full",
        fullImages: null,
      });
    });

    it("hands the updater a switch to the full images of the same version, and audits it", async () => {
      feed.respondWith(githubReleases({ tag: "v0.1.0", body: notes }));
      const { service } = build(COMMUNITY);
      // The daily check is off: the switch reads the release once by itself.
      await service.switchToFullBuild({ leadSeconds: 0 }, actor);
      expect(updater.scheduled[0]).toMatchObject({
        release: { version: "0.1.0", tag: "v0.1.0", digests: { app: FULL_APP, web: FULL_WEB } },
        mode: "image",
        switchTo: "full",
        source: null,
      });
      const [entry] = await auditRows("update.build_switch.scheduled");
      expect(entry?.details).toMatchObject({ version: "0.1.0", from: "community", to: "full" });
    });

    it("refuses a switch on the full build, and without digests of the full images", async () => {
      await expect(
        build().service.switchToFullBuild({ leadSeconds: 0 }, actor),
      ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:build-switch-refused" });
      feed.respondWith(githubReleases({ tag: "v0.1.0", body: `restow-community: ${DIGEST}` }));
      await expect(
        build(COMMUNITY).service.switchToFullBuild({ leadSeconds: 0 }, actor),
      ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:update-not-verifiable" });
      expect(updater.scheduled).toEqual([]);
    });

    it("keeps a license key sealed for the full build, never returning or auditing it", async () => {
      const { service } = build(COMMUNITY);
      const key = "restow-license-v1.eyJwYXlsb2FkIjoxfQ.c2lnbmF0dXJl";
      const view = await service.storeLicenseKey(
        { key: `${key.slice(0, 20)}\n${key.slice(20)}` },
        actor,
      );
      expect(view.edition.pendingLicenseKey).toBe(true);
      expect(JSON.stringify(view)).not.toContain(key.slice(20));
      const rows = await owner
        .select()
        .from(secrets)
        .where(eq(secrets.kind, "pending_license_key"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ciphertext).not.toContain(key.slice(20));
      const { readPendingLicenseKey } = await import("../../lib/pending-license-key.js");
      expect(await readPendingLicenseKey(providerDb)).toBe(key);
      const [entry] = await auditRows("license.pending_key.stored");
      expect(JSON.stringify(entry)).not.toContain(key.slice(20));
      expect((await service.removeLicenseKey(actor)).edition.pendingLicenseKey).toBe(false);
      await expect(build().service.storeLicenseKey({ key }, actor)).rejects.toMatchObject({
        status: 409,
      });
    });
  });

  describe("the updater's journal", () => {
    const journal = (
      id: string,
      action: "update.started" | "update.succeeded" | "update.failed",
      details = {},
    ) => ({
      id,
      at: "2026-10-01T09:10:00.000Z",
      action,
      runId: "r-1",
      actor: { userId: "owner-1", label: "owner@provider.test", ip: "192.0.2.10" },
      target: "0.2.0",
      details,
    });

    it("is written to the audit log in order, once, and remembered", async () => {
      const { service } = build();
      updater.view = idleState({
        events: [
          journal("0000000000002-2", "update.succeeded", { outcome: "succeeded", mode: "image" }),
          journal("0000000000001-1", "update.started", { mode: "image" }),
        ],
      });
      await service.syncUpdater();
      const started = await auditRows("update.started");
      const succeeded = await auditRows("update.succeeded");
      expect(started).toHaveLength(1);
      expect(succeeded).toHaveLength(1);
      expect(started[0]).toMatchObject({
        actor: "owner@provider.test",
        actorUserId: "owner-1",
        target: "0.2.0",
        targetType: "update",
      });
      expect(started[0]?.details).toMatchObject({ runId: "r-1", via: "updater", mode: "image" });
      expect(started[0]?.createdAt.getTime()).toBeLessThan(succeeded[0]?.createdAt.getTime() ?? 0);
      expect((await row()).updateAuditCursor).toBe("0000000000002-2");

      // Read again, also by a new process: nothing is written twice.
      await service.syncUpdater();
      await build().service.syncUpdater();
      expect(await auditRows("update.started")).toHaveLength(1);
      expect(await auditRows("update.succeeded")).toHaveLength(1);

      // New events after the cursor are picked up.
      updater.view = idleState({
        events: [
          journal("0000000000002-2", "update.succeeded"),
          journal("0000000000003-3", "update.failed", {
            outcome: "rolled_back",
            failureCode: "health.timeout",
          }),
        ],
      });
      await service.syncUpdater();
      expect(await auditRows("update.failed")).toHaveLength(1);
      expect(await auditRows("update.succeeded")).toHaveLength(1);
    });

    it("tells provider administrators in the bell how a run ended", async () => {
      const { service } = build();
      updater.view = idleState({
        events: [
          journal("0000000000001-1", "update.started"),
          journal("0000000000002-2", "update.failed", { outcome: "needs_attention" }),
        ],
      });
      await service.syncUpdater();
      const items = await owner.select().from(notifications).orderBy(asc(notifications.createdAt));
      expect(items.map((item) => [item.event, item.level, item.tenantId])).toEqual([
        ["update.failed", "error", null],
      ]);
      expect(items[0]?.details).toMatchObject({ version: "0.2.0", outcome: "needs_attention" });
    });

    it("waits when there is nothing to read or no updater", async () => {
      const { service } = build();
      updater.view = null;
      expect(await service.syncUpdater()).toBeNull();
      updater.view = idleState();
      await service.syncUpdater();
      expect(await owner.select().from(auditLog).where(gte(auditLog.createdAt, since))).toEqual([]);
    });
  });
});
