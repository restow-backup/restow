import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The mounter holds the Docker socket, which is root on the host. Like the updater
 * (updater/boundary.test.ts) it must not be able to reach any credential of the
 * application: no database, no configuration (master key, auth secret), no secret
 * store, no auth stack. Its sources import node built-ins, `zod`, `hono`,
 * `@hono/node-server`, `yaml`, files of this directory and the updater's own files
 * (which the updater's boundary test keeps to the same rule).
 */

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

const FORBIDDEN = [
  /^\.\.\/db(\.js)?$/,
  /^\.\.\/config(\.js)?$/,
  /^\.\.\/lib\//,
  /^\.\.\/auth(\.js)?$/,
  /^\.\.\/features\//,
  /^drizzle-orm(\/|$)/,
  /^pg(-|\/|$)/,
  /^postgres(\/|$)/,
  /^better-auth(\/|$)/,
  /^@better-auth\//,
  /^@restow\//,
];

const ALLOWED = [
  /^node:/,
  /^zod$/,
  /^yaml$/,
  /^hono(\/.*)?$/,
  /^@hono\/node-server$/,
  /^\.\/[A-Za-z0-9._-]+\.js$/,
  /^\.\.\/updater\/[A-Za-z0-9._-]+\.js$/,
];

const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

async function sources(): Promise<{ name: string; text: string }[]> {
  const names = (await fs.readdir(DIRECTORY)).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  return await Promise.all(
    names.map(async (name) => ({
      name,
      text: await fs.readFile(path.join(DIRECTORY, name), "utf8"),
    })),
  );
}

function specifiers(text: string): string[] {
  return [...text.matchAll(IMPORT)].map((match) => match[1] as string);
}

describe("mounter boundary", () => {
  it("finds the sources it is meant to check", async () => {
    const names = (await sources()).map((file) => file.name);
    for (const expected of [
      "main.ts",
      "engine.ts",
      "server.ts",
      "protocol.ts",
      "override.ts",
      "config.ts",
      "ops.ts",
      "runner-protocol.ts",
      "runner-ops.ts",
      "runner-engine.ts",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("imports none of the forbidden modules", async () => {
    for (const file of await sources()) {
      for (const specifier of specifiers(file.text)) {
        for (const pattern of FORBIDDEN) {
          expect(pattern.test(specifier), `${file.name} imports ${specifier}`).toBe(false);
        }
      }
    }
  });

  it("imports only node built-ins, zod, yaml, hono, its own files and the updater's", async () => {
    for (const file of await sources()) {
      for (const specifier of specifiers(file.text)) {
        expect(
          ALLOWED.some((pattern) => pattern.test(specifier)),
          `${file.name} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it("does not read application credentials from the environment", async () => {
    const credentialNames =
      /\b(DATABASE_URL|DATABASE_MIGRATION_URL|RESTOW_MASTER_KEY|BETTER_AUTH_SECRET|POSTGRES_PASSWORD)\b/;
    for (const file of await sources()) {
      const code = file.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const strings = [...code.matchAll(/["'`]([^"'`\n]*)["'`]/g)].map(
        (match) => match[1] as string,
      );
      for (const value of strings) {
        expect(credentialNames.test(value), `${file.name} mentions ${value}`).toBe(false);
      }
    }
  });

  it("runner exception: the persisted run record holds no secret and no share settings", async () => {
    const { PERSISTED_RUN_FIELDS } = await import("./runner-engine.js");
    expect(PERSISTED_RUN_FIELDS.length).toBeGreaterThan(0);
    for (const field of PERSISTED_RUN_FIELDS) {
      expect(field, field).not.toMatch(
        /password|token|secret|spec|share$|options|^o$|mounts|username/i,
      );
    }
  });

  it("runner exception: only the runner files handle share passwords and run tokens", async () => {
    for (const file of await sources()) {
      const handles = /\.password\b|RESTOW_SHARE_RUN_TOKEN|\brequest\.token\b/.test(file.text);
      if (handles) {
        expect(file.name, `${file.name} handles a runner secret`).toMatch(
          /^runner-(ops|engine)\.ts$/,
        );
      }
    }
  });

  it("runner exception: runner requests are not written to the operation history or logged", async () => {
    const files = await sources();
    const engine = (files.find((file) => file.name === "runner-engine.ts")?.text ?? "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // The runner never touches the operation store of share mounts.
    expect(engine).not.toMatch(/OperationStore|store\.begin|history/);
    // Log lines name runs, never a request, a spec or its options.
    for (const match of engine.matchAll(/logger\.(?:info|warn|error)\(([^;]*)\);/g)) {
      expect(match[1], match[0]).not.toMatch(
        /\b(request|spec|share|options|password|token)\b(?!Id)/,
      );
    }
  });

  it("the scanner itself recognises the patterns it should reject", () => {
    const bad = [
      'import { db } from "../db.js";',
      "import x from '../config.js'",
      'await import("../lib/secrets.js")',
      'import { s } from "../features/storage/service.js";',
      'import "drizzle-orm";',
      'import { s } from "@restow/core";',
    ];
    for (const line of bad) {
      const found = specifiers(line);
      expect(found).toHaveLength(1);
      expect(FORBIDDEN.some((pattern) => pattern.test(found[0] as string))).toBe(true);
    }
  });
});
