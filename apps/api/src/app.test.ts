import { existsSync, readdirSync } from "node:fs";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

/**
 * Wiring of the assembled application: every feature under ./features that
 * declares a mount path (meta.ts) is reachable under /api/v1 with each of its
 * routes, and no two features claim the same method and path. A feature that
 * is built but never mounted, or mounted under the wrong path, fails here
 * instead of answering 404 in production.
 *
 * Building the app opens no connection: the database pools connect on the
 * first query, and no request is sent.
 */

const API_V1 = "/api/v1";
const FEATURES = new URL("./features/", import.meta.url);

interface RouteEntry {
  method: string;
  path: string;
}

interface Feature {
  name: string;
  mountPath: string;
  routes: readonly RouteEntry[];
}

/** Hono's own path join: a sub-app's "/" is the mount path itself. */
function joinPath(base: string, path: string): string {
  if (path === "/") {
    return base;
  }
  return `${base}${path}`;
}

function isRouter(value: unknown): value is Hono {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { routes?: unknown }).routes) &&
    typeof (value as { fetch?: unknown }).fetch === "function"
  );
}

/** A module of this package by a path known only at run time. */
async function importModule(specifier: string): Promise<Record<string, unknown>> {
  return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
}

async function loadFeatures(): Promise<Feature[]> {
  const features: Feature[] = [];
  const names = readdirSync(FEATURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    if (!existsSync(new URL(`./${name}/meta.ts`, FEATURES))) {
      continue;
    }
    const meta = (await importModule(`./features/${name}/meta.js`)) as { mountPath?: unknown };
    const module = await importModule(`./features/${name}/routes.js`);
    const router = module[`${name}Routes`];
    if (typeof meta.mountPath !== "string" || !isRouter(router)) {
      throw new Error(`features/${name} must export mountPath and ${name}Routes`);
    }
    features.push({
      name,
      mountPath: meta.mountPath,
      routes: router.routes.map(({ method, path }) => ({ method, path })),
    });
  }
  return features;
}

describe("app wiring", async () => {
  const app = buildApp();
  const mounted = new Set(app.routes.map(({ method, path }) => `${method} ${path}`));
  const features = await loadFeatures();

  it("finds the features", () => {
    expect(features.map((feature) => feature.name)).toEqual(
      expect.arrayContaining(["dashboard", "jobs", "restore", "schedules", "stats"]),
    );
  });

  for (const feature of features) {
    it(`mounts every route of features/${feature.name} under ${API_V1}${feature.mountPath}`, () => {
      const base = `${API_V1}${feature.mountPath}`;
      const missing = feature.routes
        .map(({ method, path }) => `${method} ${joinPath(base, path)}`)
        .filter((route) => !mounted.has(route));
      expect(feature.routes.length).toBeGreaterThan(0);
      expect(missing).toEqual([]);
    });
  }

  it("gives each feature its own mount path", () => {
    const paths = features.map((feature) => feature.mountPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("lets no two features claim the same method and path", () => {
    // Hono keeps one entry per handler, so a route with its own middleware
    // appears once per handler of the same feature; only other owners count.
    const owners = new Map<string, Set<string>>();
    for (const feature of features) {
      const base = `${API_V1}${feature.mountPath}`;
      for (const { method, path } of feature.routes) {
        // Middleware registrations ("ALL", "*") are not endpoints.
        if (method === "ALL") {
          continue;
        }
        const route = `${method} ${joinPath(base, path)}`;
        owners.set(route, new Set([...(owners.get(route) ?? []), feature.name]));
      }
    }
    const shared = [...owners]
      .filter(([, names]) => names.size > 1)
      .map(([route, names]) => `${route}: ${[...names].join(", ")}`);
    expect(shared).toEqual([]);
  });
});
