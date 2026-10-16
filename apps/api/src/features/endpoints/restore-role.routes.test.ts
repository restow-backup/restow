import { Readable } from "node:stream";
import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, ProblemError } from "../../problem.js";

/**
 * The restore operator (`tenant_restore`, middleware/rbac.ts) on the file
 * restore of machines and Proxmox VE guests (endpoints/routes.ts,
 * pve/routes.ts): lists the machines and guests, opens one with its restore
 * points, browses, downloads and restores files onto the machine, each call
 * handed to the audited service with the person as actor. Everything else
 * (backing up now, configuration, tokens, revoking, the repository password,
 * jobs, putting a guest back as a whole) stays with the admins. Sign-in is
 * replaced at its module boundary by the real role decision of rbac.ts; the
 * services are replaced so that only the routes' rules are under test.
 */

const ids = vi.hoisted(() => ({
  tenant: "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70",
  endpoint: "11111111-1111-4111-8111-111111111111",
  guest: "33333333-3333-4333-8333-333333333333",
  point: "44444444-4444-4444-8444-444444444444",
  download: "22222222-2222-4222-8222-222222222222",
}));
const who = vi.hoisted(() => ({ membership: "restore" }));
const endpointService = vi.hoisted(() => ({
  listEndpoints: vi.fn(),
  getEndpoint: vi.fn(),
  listSnapshots: vi.fn(),
  browseSnapshot: vi.fn(),
  prepareDownload: vi.fn(),
  openDownload: vi.fn(),
  createTask: vi.fn(),
  updateEndpoint: vi.fn(),
  revokeEndpoint: vi.fn(),
  requestUninstall: vi.fn(),
  requestRestoreTest: vi.fn(),
  revealRepositoryPassword: vi.fn(),
  createEnrollmentToken: vi.fn(),
  revokeEnrollmentToken: vi.fn(),
  listEnrollmentTokens: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  getAgentUpdates: vi.fn(),
  setAgentUpdates: vi.fn(),
  resumeMachineUpdates: vi.fn(),
}));
const pveService = vi.hoisted(() => ({
  overview: vi.fn(),
  guestDetail: vi.fn(),
  backupNow: vi.fn(),
  assignJob: vi.fn(),
  restoreSnapshot: vi.fn(),
  requestVerify: vi.fn(),
  saveJob: vi.fn(),
  deleteJob: vi.fn(),
  revokeNode: vi.fn(),
  createEnrollmentToken: vi.fn(),
}));
const pveFiles = vi.hoisted(() => ({
  browseContainerFiles: vi.fn(),
  prepareContainerDownload: vi.fn(),
  openContainerDownload: vi.fn(),
}));
const bootTests = vi.hoisted(() => ({ requestBootTest: vi.fn() }));
const policyService = vi.hoisted(() => ({
  getEndpointAgentPolicy: vi.fn(),
  getTenantAgentPolicy: vi.fn(),
  updateTenantAgentPolicy: vi.fn(),
}));

vi.mock("../../db.js", () => ({ db: {}, providerDb: {}, authDb: {} }));
vi.mock("../../middleware/session.js", async () => {
  const { decideTenantAccess } = await import("../../middleware/rbac.js");
  const user = { id: "user-1", email: "restore@contoso.example" };
  type Minimum = "tenant_admin" | "tenant_restore" | "tenant_user";
  // The real decision of rbac.ts, with the problem resolveTenantAccess answers.
  const decide = (minimumRole: Minimum, selector: string | undefined) => {
    if (selector !== ids.tenant) {
      throw new ProblemError(404, "Tenant not found");
    }
    const decision = decideTenantAccess({
      isProviderAdmin: false,
      membershipRole: who.membership,
      minimumRole,
    });
    if (!decision.allowed) {
      throw new ProblemError(403, "Insufficient role", {
        extensions: { requiredRole: minimumRole, role: decision.role },
      });
    }
    return { tenant: { id: ids.tenant, status: "active" }, role: decision.role };
  };
  return {
    TENANT_HEADER: "x-restow-tenant",
    requireTenant:
      (minimumRole: Minimum = "tenant_user") =>
      async (c: Context, next: () => Promise<void>) => {
        const { tenant, role } = decide(minimumRole, c.req.header("x-restow-tenant"));
        c.set("tenantId", tenant.id);
        c.set("tenant", tenant);
        c.set("role", role);
        c.set("user", user);
        c.set("auth", { session: { createdAt: new Date() }, user });
        c.set("isProviderAdmin", false);
        c.set("providerAccess", null);
        await next();
      },
    authenticate: async () => ({
      auth: {},
      user,
      isProviderAdmin: false,
      providerAccess: null,
      memberships: [],
    }),
    assertProviderRoute: () => undefined,
    resolveTenantAccess: async (_state: unknown, selector: string | undefined, minimum: Minimum) =>
      decide(minimum, selector),
  };
});
vi.mock("./service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service.js")>()),
  ...endpointService,
}));
vi.mock("../pve/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pve/service.js")>()),
  ...pveService,
}));
vi.mock("../pve/files.js", () => pveFiles);
vi.mock("./instance-url.js", () => ({
  instanceUrl: async () => ({ url: "https://restow.test.example", configured: true }),
}));
vi.mock("../pve/boot-tests.js", () => bootTests);
vi.mock("./agent-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-policy.js")>()),
  ...policyService,
}));

const { endpointsRoutes } = await import("./routes.js");
const { pveRoutes } = await import("../pve/routes.js");

const app = new Hono();
app.onError(errorHandler);
app.route("/endpoints", endpointsRoutes);
app.route("/pve", pveRoutes);

const snapshotId = "a".repeat(64);
const headers = { "content-type": "application/json", "x-restow-tenant": ids.tenant };
const call = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const machine = (path = "") => `/endpoints/${ids.endpoint}${path}`;

const hooks = { pre: "PGPASSWORD=secret pg_dumpall > /srv/all.sql", post: "" };

beforeEach(() => {
  vi.clearAllMocks();
  who.membership = "restore";
  endpointService.listEndpoints.mockResolvedValue([]);
  endpointService.getEndpoint.mockImplementation(
    async (
      _db: unknown,
      _tenantId: string,
      id: string,
      _url: string,
      options: { revealHooks: boolean },
    ) => ({ id, config: { hooks: options.revealHooks ? hooks : {} } }),
  );
  endpointService.listSnapshots.mockResolvedValue([]);
  policyService.getEndpointAgentPolicy.mockResolvedValue({ job: null, effective: {} });
  endpointService.browseSnapshot.mockResolvedValue({ entries: [], nextCursor: null });
  endpointService.prepareDownload.mockResolvedValue({ id: ids.download, items: 1 });
  endpointService.openDownload.mockResolvedValue({
    fileName: "files.zip",
    stream: Readable.from([Buffer.from("PK")]),
  });
  endpointService.createTask.mockResolvedValue({ id: "task-1", alreadyQueued: false });
  pveService.overview.mockResolvedValue({ clusters: [], guests: [], jobs: [] });
  pveService.guestDetail.mockResolvedValue({ guest: { id: ids.guest }, snapshots: [] });
  pveFiles.browseContainerFiles.mockResolvedValue({ entries: [], nextCursor: null });
  pveFiles.prepareContainerDownload.mockResolvedValue({ id: ids.download, items: 1 });
  pveFiles.openContainerDownload.mockResolvedValue({
    fileName: "files.zip",
    stream: Readable.from([Buffer.from("PK")]),
  });
});

/** The actor every audited service call receives: the restore operator. */
const operator = expect.objectContaining({ userId: "user-1", label: "restore@contoso.example" });

describe("a restore operator on a machine's files", () => {
  it("lists the machines and opens one, without its hook texts", async () => {
    expect((await call("GET", "/endpoints")).status).toBe(200);
    const detail = await call("GET", machine());
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ config: { hooks: {} } });
    expect(endpointService.getEndpoint.mock.calls[0]?.[4]).toEqual({ revealHooks: false });
  });

  it("reads the agent policy that applies to a machine, but not the tenant's to change", async () => {
    const policy = await call("GET", machine("/agent-policy"));
    expect(policy.status).toBe(200);
    expect(policyService.getEndpointAgentPolicy).toHaveBeenCalledWith({}, ids.tenant, ids.endpoint);
    expect((await call("GET", "/endpoints/agent-policy")).status).toBe(403);
    expect((await call("PUT", "/endpoints/agent-policy", { retries: 1 })).status).toBe(403);
    expect(policyService.updateTenantAgentPolicy).not.toHaveBeenCalled();
  });

  it("reads the restore points and browses one, audited as the operator", async () => {
    expect((await call("GET", machine("/snapshots"))).status).toBe(200);
    const browse = await call("GET", machine(`/browse?snapshotId=${snapshotId}&path=/`));
    expect(browse.status).toBe(200);
    expect(endpointService.browseSnapshot).toHaveBeenCalledWith(
      {},
      ids.tenant,
      ids.endpoint,
      expect.objectContaining({ snapshotId }),
      operator,
      expect.anything(),
    );
  });

  it("prepares a ZIP and starts it with the tenant in the query", async () => {
    const prepared = await call("POST", machine("/downloads"), { snapshotId, paths: ["/etc"] });
    expect(prepared.status).toBe(201);
    expect(endpointService.prepareDownload.mock.calls[0]?.[4]).toEqual(operator);
    const started = await app.request(machine(`/downloads/${ids.download}?tenant=${ids.tenant}`));
    expect(started.status).toBe(200);
    expect(started.headers.get("content-type")).toBe("application/zip");
    expect(endpointService.openDownload.mock.calls[0]?.[4]).toEqual(operator);
  });

  it("restores files onto the machine, but may not back it up now", async () => {
    const restore = await call("POST", machine("/tasks"), {
      kind: "restore",
      snapshotId,
      paths: ["/etc/hosts"],
    });
    expect(restore.status).toBe(202);
    expect(endpointService.createTask).toHaveBeenCalledWith(
      {},
      ids.tenant,
      ids.endpoint,
      expect.objectContaining({ kind: "restore" }),
      operator,
    );

    const backup = await call("POST", machine("/tasks"), { kind: "backup_now" });
    expect(backup.status).toBe(403);
    expect(await backup.json()).toMatchObject({
      requiredRole: "tenant_admin",
      role: "tenant_restore",
    });
    expect(endpointService.createTask).toHaveBeenCalledTimes(1);
  });

  it("changes, deletes and reveals nothing", async () => {
    const refused: [string, string, unknown?][] = [
      ["PATCH", machine(), { displayName: "db-1" }],
      ["POST", machine("/revoke"), {}],
      ["POST", machine("/uninstall"), {}],
      ["POST", machine("/restore-test"), {}],
      ["POST", machine("/repository-password"), {}],
      ["GET", machine("/runs")],
      ["GET", "/endpoints/tokens"],
      ["POST", "/endpoints/tokens", { profile: "server", os: "linux" }],
      ["DELETE", `/endpoints/tokens/${ids.download}`],
      ["GET", "/endpoints/agent-updates"],
      ["PUT", "/endpoints/agent-updates", { paused: true }],
    ];
    for (const [method, path, body] of refused) {
      expect((await call(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    for (const fn of [
      endpointService.updateEndpoint,
      endpointService.revokeEndpoint,
      endpointService.requestUninstall,
      endpointService.requestRestoreTest,
      endpointService.revealRepositoryPassword,
      endpointService.createEnrollmentToken,
      endpointService.setAgentUpdates,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("is still refused to a plain user, who restores only their own accounts", async () => {
    who.membership = "member";
    expect((await call("GET", "/endpoints")).status).toBe(403);
    expect((await call("GET", machine("/agent-policy"))).status).toBe(403);
    expect((await call("GET", machine(`/browse?snapshotId=${snapshotId}&path=/`))).status).toBe(
      403,
    );
    expect(
      (await call("POST", machine("/downloads"), { snapshotId, paths: ["/etc"] })).status,
    ).toBe(403);
    expect(
      (await app.request(machine(`/downloads/${ids.download}?tenant=${ids.tenant}`))).status,
    ).toBe(403);
    expect(endpointService.browseSnapshot).not.toHaveBeenCalled();
  });

  it("leaves an admin the hook texts and backing up now", async () => {
    who.membership = "admin";
    await call("GET", machine());
    expect(endpointService.getEndpoint.mock.calls[0]?.[4]).toEqual({ revealHooks: true });
    expect((await call("POST", machine("/tasks"), { kind: "backup_now" })).status).toBe(202);
  });
});

describe("a restore operator on a Proxmox VE guest's files", () => {
  const point = (path: string) => `/pve/snapshots/${ids.point}${path}`;

  it("reads the overview and a guest with its restore points", async () => {
    expect((await call("GET", "/pve")).status).toBe(200);
    expect((await call("GET", `/pve/guests/${ids.guest}`)).status).toBe(200);
  });

  it("browses a restore point and downloads files, audited as the operator", async () => {
    expect((await call("GET", point("/files?path=/"))).status).toBe(200);
    expect(pveFiles.browseContainerFiles.mock.calls[0]).toContainEqual(operator);
    expect((await call("POST", point("/downloads"), { paths: ["/etc"] })).status).toBe(201);
    expect(pveFiles.prepareContainerDownload.mock.calls[0]).toContainEqual(operator);
    const started = await app.request(point(`/downloads/${ids.download}?tenant=${ids.tenant}`));
    expect(started.status).toBe(200);
    expect(pveFiles.openContainerDownload.mock.calls[0]).toContainEqual(operator);
  });

  it("changes, deletes and restores no guest as a whole", async () => {
    const refused: [string, string, unknown?][] = [
      ["POST", `/pve/guests/${ids.guest}/backup`, {}],
      ["PUT", `/pve/guests/${ids.guest}/job`, { jobId: null }],
      ["POST", point("/restore"), {}],
      ["POST", point("/verify"), {}],
      ["POST", point("/boot-test"), {}],
      ["POST", "/pve/tokens", {}],
      ["POST", `/pve/nodes/${ids.guest}/revoke`, {}],
      ["POST", "/pve/jobs", {}],
      ["PATCH", `/pve/jobs/${ids.guest}`, {}],
      ["DELETE", `/pve/jobs/${ids.guest}`],
    ];
    for (const [method, path, body] of refused) {
      expect((await call(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    for (const fn of [
      pveService.backupNow,
      pveService.assignJob,
      pveService.restoreSnapshot,
      pveService.requestVerify,
      pveService.saveJob,
      pveService.deleteJob,
      pveService.revokeNode,
      pveService.createEnrollmentToken,
      bootTests.requestBootTest,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("is still refused to a plain user", async () => {
    who.membership = "member";
    expect((await call("GET", "/pve")).status).toBe(403);
    expect((await call("GET", point("/files?path=/"))).status).toBe(403);
    expect((await call("POST", point("/downloads"), { paths: ["/etc"] })).status).toBe(403);
    expect(pveFiles.browseContainerFiles).not.toHaveBeenCalled();
  });
});
