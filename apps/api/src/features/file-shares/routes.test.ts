import { Readable } from "node:stream";
import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemError, errorHandler } from "../../problem.js";

/**
 * The HTTP side of /api/v1/file-shares (routes.ts): what each route reads from the request, the
 * status it answers with, the recent sign-in before deleting backups and showing the repository
 * password, the provider-only approval, and a probe (HEAD) never using up a download. Sign-in
 * and the service are replaced at their module boundary; the service is tested against
 * Postgres in tenant.pg.test.ts and browse.pg.test.ts.
 */

const ids = vi.hoisted(() => ({
  tenant: "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70",
  share: "11111111-1111-4111-8111-111111111111",
  download: "22222222-2222-4222-8222-222222222222",
}));
const service = vi.hoisted(() => ({
  createShare: vi.fn(),
  backupNow: vi.fn(),
  purgeShare: vi.fn(),
  revealRepositoryPassword: vi.fn(),
  setPrivateNetworkApproval: vi.fn(),
  testUnsavedShare: vi.fn(),
  requestRestore: vi.fn(),
}));
const browse = vi.hoisted(() => ({ openDownload: vi.fn(), prepareDownload: vi.fn() }));

vi.mock("../../db.js", () => ({ db: {}, providerDb: {} }));
vi.mock("../../middleware/session.js", () => {
  const user = { id: "user-1", email: "admin@contoso.example" };
  const apply = (c: Context) => {
    const provider = c.req.header("x-test-provider") === "1";
    const age = Number(c.req.header("x-test-session-age") ?? "5");
    c.set("tenantId", ids.tenant);
    c.set("user", user);
    c.set("isProviderAdmin", provider);
    c.set("providerAccess", provider ? { role: "administrator" } : null);
    c.set("auth", {
      session: { createdAt: new Date(Date.now() - age * 1000), authMethod: "passkey" },
    });
  };
  return {
    TENANT_HEADER: "x-restow-tenant",
    requireTenant: () => async (c: Context, next: () => Promise<void>) => {
      apply(c);
      await next();
    },
    requireProviderAdmin: async (c: Context, next: () => Promise<void>) => {
      apply(c);
      await next();
    },
    refuseApiKeys: async (_c: Context, next: () => Promise<void>) => next(),
    authenticate: async () => ({
      auth: {},
      user,
      isProviderAdmin: false,
      providerAccess: null,
      memberships: [],
    }),
    assertProviderRoute: () => undefined,
    resolveTenantAccess: async (_state: unknown, selector: string | undefined) => {
      if (selector !== ids.tenant) {
        throw new ProblemError(403, "Forbidden");
      }
      return { tenant: { id: ids.tenant }, role: "tenant_admin" };
    },
  };
});
vi.mock("./service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service.js")>()),
  ...service,
}));
vi.mock("./browse.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browse.js")>()),
  ...browse,
}));

const { fileSharesRoutes } = await import("./routes.js");

const app = new Hono();
app.onError(errorHandler);
app.route("/file-shares", fileSharesRoutes);

const json = { "content-type": "application/json", "x-restow-tenant": ids.tenant };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adding and testing", () => {
  it("creates a share from a valid body and answers 201", async () => {
    service.createShare.mockResolvedValue({ id: ids.share });
    const response = await app.request("/file-shares", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        protocol: "smb",
        name: "Data",
        server: "Files.Example.test",
        share: "data",
        account: "CONTOSO\\backup",
        password: "pw",
      }),
    });
    expect(response.status).toBe(201);
    const input = service.createShare.mock.calls[0]?.[2];
    expect(input).toMatchObject({
      server: "files.example.test",
      subfolder: "",
      smbVersion: "3.1.1",
      seal: false,
      allowRestore: false,
    });
  });

  it("refuses a server with a protocol or a path before anything runs", async () => {
    const response = await app.request("/file-shares/test", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        protocol: "nfs",
        server: "nfs://nas/srv",
        export: "/srv",
      }),
    });
    expect(response.status).toBe(422);
    expect(service.testUnsavedShare).not.toHaveBeenCalled();
  });

  it("refuses SMB 2.1 with encryption", async () => {
    const response = await app.request("/file-shares/test", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        protocol: "smb",
        server: "nas",
        share: "data",
        account: "backup",
        password: "pw",
        smbVersion: "2.1",
        seal: true,
      }),
    });
    expect(response.status).toBe(422);
  });
});

describe("runs", () => {
  it("backs up now without a body (202), and answers 200 for one that waits already", async () => {
    service.backupNow.mockResolvedValueOnce({ run: { id: "r" }, alreadyQueued: false });
    const first = await app.request(`/file-shares/${ids.share}/backup`, {
      method: "POST",
      headers: { "x-restow-tenant": ids.tenant },
    });
    expect(first.status).toBe(202);
    expect(service.backupNow.mock.calls[0]?.[3]).toEqual({ allowEmptyOnce: false });
    service.backupNow.mockResolvedValueOnce({ run: { id: "r" }, alreadyQueued: true });
    const second = await app.request(`/file-shares/${ids.share}/backup`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ allowEmptyOnce: true }),
    });
    expect(second.status).toBe(200);
    expect(service.backupNow.mock.calls[1]?.[3]).toEqual({ allowEmptyOnce: true });
  });

  it("checks a restore's destination before the service", async () => {
    const response = await app.request(`/file-shares/${ids.share}/restores`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        snapshotId: ids.download,
        destination: "other_share",
        paths: ["/a"],
      }),
    });
    expect(response.status).toBe(422);
    expect(service.requestRestore).not.toHaveBeenCalled();
  });
});

describe("what needs a recent sign-in or a provider admin", () => {
  it("deletes backups only with a recent sign-in", async () => {
    service.purgeShare.mockResolvedValue({ queued: true });
    const old = await app.request(`/file-shares/${ids.share}`, {
      method: "DELETE",
      headers: { ...json, "x-test-session-age": "3600" },
      body: JSON.stringify({ confirmName: "Data" }),
    });
    expect(old.status).toBe(403);
    expect(((await old.json()) as { type: string }).type).toBe(
      "urn:restow:problem:recent-sign-in-required",
    );
    const fresh = await app.request(`/file-shares/${ids.share}`, {
      method: "DELETE",
      headers: json,
      body: JSON.stringify({ confirmName: "Data" }),
    });
    expect(fresh.status).toBe(202);
    expect(service.purgeShare.mock.calls[0]?.[3]).toBe("Data");
  });

  it("shows the repository password only after a recent sign-in, never cached", async () => {
    service.revealRepositoryPassword.mockResolvedValue({ password: "p", storagePrefix: "x/" });
    const old = await app.request(`/file-shares/${ids.share}/repository-password`, {
      method: "POST",
      headers: { ...json, "x-test-session-age": "3600" },
    });
    expect(old.status).toBe(403);
    const fresh = await app.request(`/file-shares/${ids.share}/repository-password`, {
      method: "POST",
      headers: json,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("cache-control")).toBe("no-store");
  });

  it("lets only provider admins approve a private network", async () => {
    service.setPrivateNetworkApproval.mockResolvedValue({ id: ids.share });
    const tenant = await app.request(`/file-shares/${ids.share}/private-network-approval`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ approved: true }),
    });
    expect(tenant.status).toBe(403);
    const provider = await app.request(`/file-shares/${ids.share}/private-network-approval`, {
      method: "PUT",
      headers: { ...json, "x-test-provider": "1" },
      body: JSON.stringify({ approved: true }),
    });
    expect(provider.status).toBe(200);
    expect(service.setPrivateNetworkApproval.mock.calls[0]?.[4]).toMatchObject({
      isProviderAdmin: true,
      providerRole: "administrator",
    });
  });
});

describe("downloads", () => {
  it("never uses up a download on HEAD and streams a ZIP on GET", async () => {
    const head = await app.request(
      `/file-shares/${ids.share}/downloads/${ids.download}?tenant=${ids.tenant}`,
      { method: "HEAD" },
    );
    expect(head.status).toBe(405);
    expect(browse.openDownload).not.toHaveBeenCalled();
    browse.openDownload.mockResolvedValue({
      stream: Readable.from([Buffer.from("PK")]),
      fileName: "Data files/2026.zip",
    });
    const get = await app.request(
      `/file-shares/${ids.share}/downloads/${ids.download}?tenant=${ids.tenant}`,
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("content-disposition")).toBe(
      'attachment; filename="Data_files_2026.zip"',
    );
  });
});
