import { Readable } from "node:stream";
import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemError, errorHandler } from "../../problem.js";

/**
 * The HTTP side of the ZIP download (routes.ts): the paths travel in the body
 * of a POST, the prepared download is started with a GET that a browser
 * navigation can make, and a probe (HEAD) never uses it up. Sign-in and the
 * service are replaced at their module boundary; what is tested is what the
 * routes do with the request and the response.
 */

const ids = vi.hoisted(() => ({
  tenant: "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70",
  endpoint: "11111111-1111-4111-8111-111111111111",
  download: "22222222-2222-4222-8222-222222222222",
}));
const service = vi.hoisted(() => ({ prepareDownload: vi.fn(), openDownload: vi.fn() }));

vi.mock("../../db.js", () => ({ db: {}, providerDb: {} }));
vi.mock("../../middleware/session.js", () => {
  const user = { id: "user-1", email: "admin@contoso.example" };
  return {
    TENANT_HEADER: "x-restow-tenant",
    requireTenant: () => async (c: Context, next: () => Promise<void>) => {
      c.set("tenantId", ids.tenant);
      c.set("user", user);
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
    // A navigation names the tenant in the query; without it nothing resolves.
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
  prepareDownload: service.prepareDownload,
  openDownload: service.openDownload,
}));

const { endpointsRoutes } = await import("./routes.js");

const app = new Hono();
app.onError(errorHandler);
app.route("/endpoints", endpointsRoutes);

const snapshotId = "a".repeat(64);
const json = { "content-type": "application/json", "x-restow-tenant": ids.tenant };
const post = (body: string) =>
  app.request(`/endpoints/${ids.endpoint}/downloads`, { method: "POST", headers: json, body });
const start = (method = "GET", tenant: string | null = ids.tenant) =>
  app.request(
    `/endpoints/${ids.endpoint}/downloads/${ids.download}${tenant ? `?tenant=${tenant}` : ""}`,
    { method },
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("preparing a download", () => {
  it("takes the paths in the body and answers with the prepared download", async () => {
    const prepared = { id: ids.download, expiresAt: "2026-09-30T12:10:00.000Z", items: 2 };
    service.prepareDownload.mockResolvedValue(prepared);
    const response = await post(
      JSON.stringify({ snapshotId, paths: ["/etc", "/home/ada/a b.txt"] }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(prepared);
    const [, tenantId, endpointId, input, actor] = service.prepareDownload.mock.calls[0] ?? [];
    expect(tenantId).toBe(ids.tenant);
    expect(endpointId).toBe(ids.endpoint);
    expect(input).toEqual({ snapshotId, paths: ["/etc", "/home/ada/a b.txt"] });
    expect(actor).toMatchObject({ userId: "user-1", label: "admin@contoso.example" });
  });

  it("takes ten thousand paths of a normal length", async () => {
    service.prepareDownload.mockResolvedValue({ id: ids.download, expiresAt: "x", items: 10_000 });
    const paths = Array.from(
      { length: 10_000 },
      (_, index) => `/srv/data/project/file-${index}.txt`,
    );
    expect((await post(JSON.stringify({ snapshotId, paths }))).status).toBe(201);
  });

  it("refuses more than ten thousand paths as a validation error", async () => {
    const paths = Array.from({ length: 10_001 }, (_, index) => `/f${index}`);
    const response = await post(JSON.stringify({ snapshotId, paths }));
    expect(response.status).toBe(422);
    expect(service.prepareDownload).not.toHaveBeenCalled();
  });

  it("refuses a body that is too large before it parses it, with a type of its own", async () => {
    const paths = Array.from({ length: 9000 }, (_, index) => `/${"x".repeat(600)}${index}`);
    const response = await post(JSON.stringify({ snapshotId, paths }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      type: "urn:restow:problem:endpoint-download-too-large",
    });
    expect(service.prepareDownload).not.toHaveBeenCalled();
    // The declared length is enough to refuse it.
    const declared = await app.request(`/endpoints/${ids.endpoint}/downloads`, {
      method: "POST",
      headers: { ...json, "content-length": String(50 * 1024 * 1024) },
      body: "{}",
    });
    expect(declared.status).toBe(413);
  });

  it("refuses a body that is not a selection", async () => {
    for (const body of ["not json", "null", "{}", JSON.stringify({ snapshotId, paths: [] })]) {
      expect((await post(body)).status).toBe(422);
    }
    expect(service.prepareDownload).not.toHaveBeenCalled();
  });
});

describe("starting a prepared download", () => {
  it("streams the ZIP as an attachment and names the tenant in the query", async () => {
    service.openDownload.mockResolvedValue({
      stream: Readable.from([Buffer.from("PK-zip-bytes")]),
      fileName: "web 01/../snapshot-aaaa.zip",
    });
    const response = await start();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // The file name cannot carry a path or a quote into the header.
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="web_01_.._snapshot-aaaa.zip"',
    );
    expect(await response.text()).toBe("PK-zip-bytes");
    const [, tenantId, endpointId, downloadId, actor] = service.openDownload.mock.calls[0] ?? [];
    expect([tenantId, endpointId, downloadId]).toEqual([ids.tenant, ids.endpoint, ids.download]);
    expect(actor).toMatchObject({ userId: "user-1" });
  });

  it("does not resolve a tenant that the query does not name", async () => {
    const response = await start("GET", null);
    expect(response.status).toBe(403);
    expect(service.openDownload).not.toHaveBeenCalled();
  });

  it("does not let a probe use the download up", async () => {
    const response = await start("HEAD");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(service.openDownload).not.toHaveBeenCalled();
  });

  it("passes on the answer for a download that is gone", async () => {
    service.openDownload.mockRejectedValue(
      new ProblemError(404, "Download not found", {
        type: "urn:restow:problem:endpoint-download-gone",
      }),
    );
    const response = await start();
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      type: "urn:restow:problem:endpoint-download-gone",
    });
  });

  it("refuses ids that are not ids", async () => {
    const response = await app.request(
      `/endpoints/${ids.endpoint}/downloads/nope?tenant=${ids.tenant}`,
    );
    expect(response.status).toBe(422);
    expect(service.openDownload).not.toHaveBeenCalled();
  });
});
