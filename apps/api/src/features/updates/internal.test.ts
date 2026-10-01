import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The routes only the opt-in updater may use: GET /internal/updater/source-token
 * and the running version on /readyz. Both need the shared secret; the token
 * route also refuses anything that came through a proxy and never answers in
 * the demo.
 */

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// The secret file is read when the module loads its reader, so it exists before the import.
const mocks = vi.hoisted(() => {
  const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "restow-updater-secret-"));
  writeFileSync(
    join(dir, "secret"),
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
    {
      mode: 0o600,
    },
  );
  process.env.RESTOW_UPDATER_SECRET_FILE = join(dir, "secret");
  return { demo: false, token: null as string | null, reads: 0 };
});

vi.mock("../../config.js", () => ({
  config: {
    get demo() {
      return { enabled: mocks.demo };
    },
  },
}));
vi.mock("../../db.js", () => ({ providerDb: {} }));
vi.mock("./token.js", () => ({
  tokenFor: vi.fn(async (_db: unknown, origin: string) => {
    mocks.reads += 1;
    return origin === "https://git.example.com" ? mocks.token : null;
  }),
}));

const { internalRoutes, isUpdater } = await import("./internal.js");
const { updateState } = await import("./state-instance.js");
const { parseRepositoryUrl } = await import("./source.js");

function app() {
  const root = new Hono();
  root.route("/internal", internalRoutes);
  return root;
}

function useSource(url: string, origin: "settings" | "environment" = "settings") {
  const parsed = parseRepositoryUrl(url);
  if (!parsed.ok) {
    throw new Error("bad test source");
  }
  updateState.set({
    enabled: true,
    channel: "stable",
    source: parsed.source,
    origin,
    check: null,
    maintenance: null,
  });
}

beforeEach(() => {
  mocks.demo = false;
  mocks.token = "glpat-secret-token";
  mocks.reads = 0;
  useSource("https://git.example.com/acme/restow");
});

describe("GET /internal/updater/source-token", () => {
  const path = "/internal/updater/source-token";

  it("hands the updater the token of the update source", async () => {
    const response = await app().request(path, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ token: "glpat-secret-token" });
  });

  it("answers null when no token is stored for the source's origin", async () => {
    mocks.token = null;
    const response = await app().request(path, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(await response.json()).toEqual({ token: null });
  });

  it("does not look for a token for an environment override or a feed", async () => {
    useSource("https://git.example.com/acme/restow", "environment");
    const response = await app().request(path, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(await response.json()).toEqual({ token: null });
    expect(mocks.reads).toBe(0);
  });

  it("needs the shared secret, and nothing else opens it", async () => {
    const refused: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong" },
      { authorization: `Bearer ${SECRET}x` },
      { authorization: `Basic ${SECRET}` },
      { authorization: SECRET },
    ];
    for (const headers of refused) {
      const response = await app().request(path, { headers });
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(await response.text()).toBe("");
    }
    expect(mocks.reads).toBe(0);
  });

  it("does not exist for a request that came through a proxy, secret or not", async () => {
    for (const header of ["x-forwarded-for", "x-forwarded-host"]) {
      const response = await app().request(path, {
        headers: { authorization: `Bearer ${SECRET}`, [header]: "203.0.113.9" },
      });
      expect(response.status).toBe(404);
    }
  });

  it("does not exist in the demo", async () => {
    mocks.demo = true;
    const response = await app().request(path, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(response.status).toBe(404);
  });
});

describe("isUpdater", () => {
  it("recognises the shared secret and nothing else", async () => {
    expect(await isUpdater(`Bearer ${SECRET}`)).toBe(true);
    expect(await isUpdater("Bearer nope")).toBe(false);
    expect(await isUpdater(undefined)).toBe(false);
    expect(await isUpdater(null)).toBe(false);
  });

  it("recognises nobody in the demo", async () => {
    mocks.demo = true;
    expect(await isUpdater(`Bearer ${SECRET}`)).toBe(false);
  });
});
