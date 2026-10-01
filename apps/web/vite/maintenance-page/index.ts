import { readFileSync } from "node:fs";
import path from "node:path";

import { PRODUCT_NAME_ENV, normalizeProductName } from "@restow/i18n";
import { type Plugin, transformWithEsbuild } from "vite";

import { type PageTexts, STEP_IDS, STEP_STATUSES, STYLES, renderPage } from "./template";

/**
 * Build-time generator of the static maintenance page.
 *
 * The edge serves it (from `/srv/maintenance/`) for 502, 503 and 504 on app
 * routes while the api is down, so it must stand alone: no framework, no api,
 * no external request, no inline script or style. The plugin writes, next to
 * the app in `dist/`:
 *
 *   maintenance/index.en.html   maintenance/index.de.html
 *   maintenance/maintenance.css maintenance/maintenance.js
 *
 * Texts come from the `updates` namespace (`maintenancePage.*`, `steps.*`,
 * `failure.*`) in every language. The product name is the branding's: the page
 * is written once, at build time, so it carries the name the build was given
 * (`RESTOW_PRODUCT_NAME`, the default when unset) and cannot follow a name an
 * operator sets at runtime.
 */

/** The languages the page is written in (checked against the shared package in the tests). */
export const MAINTENANCE_LANGUAGES = ["en", "de"] as const;

type Tree = { [key: string]: string | Tree };

function readJson(file: string): Tree {
  return JSON.parse(readFileSync(file, "utf8")) as Tree;
}

function pick(tree: Tree, dotted: string): string {
  let node: string | Tree | undefined = tree;
  for (const part of dotted.split(".")) {
    node = typeof node === "object" ? node[part] : undefined;
  }
  if (typeof node !== "string") {
    throw new Error(`Maintenance page: missing text "${dotted}"`);
  }
  return node;
}

/** `{ prepare: { disk_space: "..." }, interrupted: "..." }` as `{ "prepare.disk_space": "...", interrupted: "..." }`. */
function flatten(tree: Tree, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result[name] = value;
    } else {
      Object.assign(result, flatten(value, name));
    }
  }
  return result;
}

/** Where the shared translation files are, from the web app's root (`apps/web`). */
export function resourcesDirectory(root: string): string {
  return path.resolve(root, "../../packages/i18n/resources");
}

/** The product name the page is built with: the build environment's, else the default. */
export function buildProductName(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeProductName(env[PRODUCT_NAME_ENV]);
}

/** The texts of one language. */
export function loadPageTexts(
  root: string,
  lang: string,
  product: string = buildProductName(),
): PageTexts {
  const directory = path.join(resourcesDirectory(root), lang);
  const updates = readJson(path.join(directory, "updates.json"));
  const text = (key: string) => pick(updates, key);

  // "unknown" is the fallback text of the app, not a failure code the updater sends.
  const failures = Object.fromEntries(
    Object.entries(flatten(updates.failure as Tree)).filter(([code]) => code !== "unknown"),
  );

  return {
    lang,
    product,
    page: {
      heading: {
        unavailable: text("maintenancePage.heading.unavailable"),
        scheduled: text("maintenancePage.heading.scheduled"),
        scheduledVersion: text("maintenancePage.heading.scheduledVersion"),
        updating: text("maintenancePage.heading.updating"),
        updatingVersion: text("maintenancePage.heading.updatingVersion"),
        succeeded: text("maintenancePage.heading.succeeded"),
        succeededVersion: text("maintenancePage.heading.succeededVersion"),
        failed: text("maintenancePage.heading.failed"),
      },
      lead: {
        refresh: text("maintenancePage.lead.refresh"),
        scheduled: text("maintenancePage.lead.scheduled"),
        succeeded: text("maintenancePage.lead.succeeded"),
      },
      failure: {
        unchanged: text("maintenancePage.failure.unchanged"),
        rolledBack: text("maintenancePage.failure.rolledBack"),
        needsAttention: text("maintenancePage.failure.needsAttention"),
        generic: text("maintenancePage.failure.generic"),
      },
      reason: text("maintenancePage.reason"),
      restarting: text("maintenancePage.restarting"),
      retry: text("maintenancePage.retry"),
      progress: text("maintenancePage.progress"),
      stepsLabel: text("maintenancePage.stepsLabel"),
    },
    steps: Object.fromEntries(
      STEP_IDS.map((id) => [id, text(`steps.${id}`)]),
    ) as PageTexts["steps"],
    stepStatus: Object.fromEntries(
      STEP_STATUSES.map((status) => [status, text(`steps.status.${status}`)]),
    ) as PageTexts["stepStatus"],
    failures,
  };
}

/** The script for the browser: client.ts compiled to one ES2019 file that starts itself. */
export async function buildScript(root: string): Promise<string> {
  const file = path.join(root, "vite/maintenance-page/client.ts");
  const result = await transformWithEsbuild(readFileSync(file, "utf8"), file, {
    loader: "ts",
    format: "iife",
    globalName: "MaintenanceClient",
    target: "es2019",
    minify: true,
    legalComments: "none",
  });
  return `${result.code.trimEnd()}\nMaintenanceClient.bootstrap();\n`;
}

/** Every file of the page, by name (relative to `maintenance/`). */
export async function buildMaintenancePages(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {
    "maintenance.css": STYLES,
    "maintenance.js": await buildScript(root),
  };
  for (const lang of MAINTENANCE_LANGUAGES) {
    files[`index.${lang}.html`] = renderPage(loadPageTexts(root, lang));
  }
  return files;
}

/** Emits the maintenance page into `dist/maintenance/` on every production build. */
export function maintenancePagePlugin(): Plugin {
  let root = process.cwd();
  return {
    name: "maintenance-page",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async generateBundle() {
      const files = await buildMaintenancePages(root);
      for (const [name, source] of Object.entries(files)) {
        this.emitFile({ type: "asset", fileName: `maintenance/${name}`, source });
      }
    },
  };
}
