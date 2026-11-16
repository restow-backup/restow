import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler, ProblemError } from "../../problem.js";

/**
 * The routes of the native SQL Server backup (W2a, endpoints/routes.ts): a restore operator reads
 * the SQL part of a machine and the backups of a database; restoring under a new name, checking,
 * asking for a fresh inventory, the restore script and the TDE confirmation are the admins'. The
 * request shapes (the new name's rules) are checked before the service is called. Sign-in is
 * replaced at its module boundary by the real role decision of rbac.ts; the service is replaced.
 */

const ids = vi.hoisted(() => ({
  tenant: "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70",
  endpoint: "11111111-1111-4111-8111-111111111111",
  database: "22222222-2222-4222-8222-222222222222",
  backup: "33333333-3333-4333-8333-333333333333",
}));
const who = vi.hoisted(() => ({ membership: "restore" }));
const sqlService = vi.hoisted(() => ({
  getSqlOverview: vi.fn(),
  listSqlBackups: vi.fn(),
  requestSqlRestore: vi.fn(),
  requestSqlVerify: vi.fn(),
  requestSqlInventory: vi.fn(),
  sqlRestoreScript: vi.fn(),
  confirmSqlTde: vi.fn(),
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
vi.mock("./sql.js", () => sqlService);
vi.mock("./instance-url.js", () => ({
  instanceUrl: async () => ({ url: "https://restow.test.example", configured: true }),
}));

const { endpointsRoutes } = await import("./routes.js");

const app = new Hono();
app.onError(errorHandler);
app.route("/endpoints", endpointsRoutes);

const headers = { "content-type": "application/json", "x-restow-tenant": ids.tenant };
const call = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const machine = (path = "") => `/endpoints/${ids.endpoint}${path}`;

beforeEach(() => {
  vi.clearAllMocks();
  who.membership = "restore";
  sqlService.getSqlOverview.mockResolvedValue({ instances: [], databases: [] });
  sqlService.listSqlBackups.mockResolvedValue({ backups: [] });
  sqlService.requestSqlRestore.mockResolvedValue({ taskId: "task-1" });
  sqlService.requestSqlVerify.mockResolvedValue({ queued: ["SQLEXPRESS"], alreadyQueued: [] });
  sqlService.requestSqlInventory.mockResolvedValue({ alreadyQueued: false });
  sqlService.sqlRestoreScript.mockResolvedValue({
    fileName: "restore-Sales-20261105T020140Z.ps1",
    body: "\uFEFF#Requires",
  });
  sqlService.confirmSqlTde.mockResolvedValue({ confirmedAt: "2026-11-05T10:00:00.000Z" });
});

const admin = expect.objectContaining({ userId: "user-1", label: "restore@contoso.example" });

describe("the SQL Server routes of a machine", () => {
  it("let a restore operator read the SQL part and the backups of a database", async () => {
    expect((await call("GET", machine("/sql"))).status).toBe(200);
    expect(sqlService.getSqlOverview).toHaveBeenCalledWith({}, ids.tenant, ids.endpoint);
    expect((await call("GET", machine(`/sql/databases/${ids.database}/backups`))).status).toBe(200);
    expect(sqlService.listSqlBackups).toHaveBeenCalledWith(
      {},
      ids.tenant,
      ids.endpoint,
      ids.database,
    );
  });

  it("leave every action to the admins", async () => {
    const refused: [string, string, unknown?][] = [
      ["POST", machine("/sql/restore"), { backupId: ids.backup, newName: "Sales_copy" }],
      ["POST", machine("/sql/verify"), {}],
      ["POST", machine("/sql/inventory"), {}],
      ["GET", machine(`/sql/backups/${ids.backup}/restore-script`)],
      ["POST", machine(`/sql/databases/${ids.database}/tde-confirm`), {}],
    ];
    for (const [method, path, body] of refused) {
      expect((await call(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    for (const fn of [
      sqlService.requestSqlRestore,
      sqlService.requestSqlVerify,
      sqlService.requestSqlInventory,
      sqlService.sqlRestoreScript,
      sqlService.confirmSqlTde,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
    who.membership = "member";
    expect((await call("GET", machine("/sql"))).status).toBe(403);
  });

  it("hand an admin's requests to the audited service", async () => {
    who.membership = "admin";
    const restore = await call("POST", machine("/sql/restore"), {
      backupId: ids.backup,
      newName: "Sales_copy",
      checkdb: false,
    });
    expect(restore.status).toBe(202);
    expect(sqlService.requestSqlRestore).toHaveBeenCalledWith(
      {},
      ids.tenant,
      ids.endpoint,
      { backupId: ids.backup, newName: "Sales_copy", checkdb: false },
      admin,
    );
    expect((await call("POST", machine("/sql/verify"), { databaseId: ids.database })).status).toBe(
      202,
    );
    expect((await call("POST", machine("/sql/inventory"), {})).status).toBe(202);
    const script = await call("GET", machine(`/sql/backups/${ids.backup}/restore-script`));
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(script.headers.get("content-disposition")).toBe(
      'attachment; filename="restore-Sales-20261105T020140Z.ps1"',
    );
    expect(script.headers.get("cache-control")).toBe("no-store");
    expect(
      (await call("POST", machine(`/sql/databases/${ids.database}/tde-confirm`), {})).status,
    ).toBe(200);
  });

  it("refuse a new name the agent would refuse, before the service sees it", async () => {
    who.membership = "admin";
    for (const newName of ["", "msdb", "Sales__restow_verify_x", "a\u0001b", "x".repeat(129)]) {
      const response = await call("POST", machine("/sql/restore"), {
        backupId: ids.backup,
        newName,
      });
      expect(response.status, JSON.stringify(newName)).toBe(422);
    }
    expect(
      (
        await call("POST", machine("/sql/restore"), {
          backupId: ids.backup,
          newName: "ok",
          extra: 1,
        })
      ).status,
    ).toBe(422);
    expect(sqlService.requestSqlRestore).not.toHaveBeenCalled();
  });
});
