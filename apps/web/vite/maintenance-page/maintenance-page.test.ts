import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { DEFAULT_PRODUCT_NAME, supportedLanguages } from "@restow/i18n";
import { describe, expect, it } from "vitest";

import { FAILURE_CODES } from "../../src/features/updates/api";
import {
  MAINTENANCE_LANGUAGES,
  buildMaintenancePages,
  buildProductName,
  loadPageTexts,
  maintenancePagePlugin,
} from "./index";
import { MARK, STEP_IDS, STEP_STATUSES, STYLES, escapeHtml, renderPage } from "./template";

/**
 * The generator of the static maintenance page: what it emits and the rules
 * the edge's content security policy sets (no inline script, no inline style,
 * nothing from outside).
 */

const ROOT = path.resolve(import.meta.dirname, "../..");

const files = await buildMaintenancePages(ROOT);

/** An em dash, or an en dash used as a pause (the rule of packages/i18n/src/no-em-dash.test.ts). */
const DISALLOWED_DASH = /—|(?<=\s)–|–(?=\s)/;

/** The name the pages above were built with (the build environment's, else the default). */
function commonProduct(_lang: string): string {
  return buildProductName();
}

describe("the emitted files", () => {
  it("are the two pages, the stylesheet and the script", () => {
    expect(Object.keys(files).sort()).toEqual([
      "index.de.html",
      "index.en.html",
      "maintenance.css",
      "maintenance.js",
    ]);
  });

  it("cover every language the application ships", () => {
    expect([...MAINTENANCE_LANGUAGES].sort()).toEqual([...supportedLanguages].sort());
  });
});

describe.each(MAINTENANCE_LANGUAGES)("the %s page", (lang) => {
  const html = files[`index.${lang}.html`] as string;

  it("is a standalone HTML5 document in its language, ready for phones", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<html lang="${lang}">`);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toMatch(/<title>[^<]+<\/title>/);
  });

  it("follows the visitor's light or dark setting without any script", () => {
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(STYLES).toContain("color-scheme: light dark");
    expect(STYLES).toContain("@media (prefers-color-scheme: dark)");
    expect(STYLES).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("links its stylesheet and its script by absolute path", () => {
    expect(html).toContain('<link rel="stylesheet" href="/maintenance/maintenance.css">');
    expect(html).toContain('<script src="/maintenance/maintenance.js" defer></script>');
  });

  it("has no inline script and no inline style", () => {
    // Every script element has a source and no content.
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    for (const [, attributes, content] of scripts) {
      expect(attributes).toMatch(/\bsrc="/);
      expect(content).toBe("");
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/<script[^>]*type="application\/json"/i);
  });

  it("makes no request to anywhere else", () => {
    expect(html).not.toMatch(/(?:src|href|action)\s*=\s*"(?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(/i);
    expect(STYLES).not.toMatch(/@import|url\(|https?:\/\//i);
    expect(files["maintenance.css"]).not.toMatch(/@import|url\(|https?:\/\//i);
  });

  it("carries the brand mark as decorative inline SVG coloured by the stylesheet", () => {
    expect(html).toContain(MARK);
    expect(MARK).toContain('aria-hidden="true"');
    expect(MARK).not.toMatch(/style=|fill="#|stroke="#/);
    for (const variable of ["--mark-hold", "--mark-bar"]) {
      expect(STYLES.match(new RegExp(`${variable}:`, "g")) ?? []).toHaveLength(2);
    }
  });

  it("names the product from the branding, not from the template", () => {
    const product = commonProduct(lang);
    expect(html).toContain(escapeHtml(product));
    expect(html).toContain(`<p class="brand">${escapeHtml(product)}</p>`);
    expect(html).not.toContain("{product}");
    // The placeholders the script fills stay.
    expect(html).toContain("{version}");
    expect(html).toContain("{reason}");
  });

  it("has the landmarks, the heading and the status region", () => {
    expect(html).toContain('<main id="maintenance"');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<div id="live" role="status" aria-live="polite" aria-atomic="true">/);
    expect(html).toMatch(/<progress id="progress"[^>]*aria-label="[^"]+"[^>]*hidden>/);
    expect(html).toMatch(/<ol id="steps"[^>]*aria-label="[^"]+"[^>]*hidden>/);
  });

  it("says something useful without JavaScript", () => {
    const product = commonProduct(lang);
    const heading = /<h1 id="heading">([^<]+)<\/h1>/.exec(html)?.[1] ?? "";
    expect(heading).toContain(escapeHtml(product));
    const lead = /<p id="lead" class="lead">([^<]+)<\/p>/.exec(html)?.[1] ?? "";
    expect(lead.length).toBeGreaterThan(10);
    // Everything that needs the script starts hidden, so the static page shows no empty parts.
    for (const id of ["current", "progress", "steps", "restarting", "failure"]) {
      expect(html, id).toMatch(new RegExp(`id="${id}"[^>]*\\bhidden\\b`));
    }
    // And it refreshes by itself, also without JavaScript.
    expect(html).toContain('<noscript><meta http-equiv="refresh" content="15"></noscript>');
    expect(html).toContain('<a class="button" href="">');
  });

  it("carries the text of every step, step status and failure code for the script", () => {
    for (const id of STEP_IDS) {
      expect(html).toMatch(new RegExp(`data-text-step-${id}="[^"]+"`));
      expect(html).toContain(`data-step="${id}"`);
    }
    for (const status of STEP_STATUSES) {
      expect(html).toMatch(new RegExp(`data-text-step-status-${status}="[^"]+"`));
    }
    for (const code of FAILURE_CODES) {
      const attribute = `data-failure-${code.replace(/[._]/g, "-")}`;
      expect(html, code).toMatch(new RegExp(`${attribute}="[^"]+"`));
    }
    for (const name of [
      "heading-unavailable",
      "heading-updating-version",
      "heading-succeeded-version",
      "heading-failed",
      "lead-refresh",
      "lead-succeeded",
      "failure-unchanged",
      "failure-rolled-back",
      "failure-needs-attention",
      "failure-generic",
      "reason",
    ]) {
      expect(html, name).toMatch(new RegExp(`data-text-${name}="[^"]+"`));
    }
  });

  it("has no em dash and no dash used as a pause", () => {
    expect(DISALLOWED_DASH.test(html)).toBe(false);
    expect(html).not.toMatch(/[—–]/);
  });
});

describe("the two languages", () => {
  it("say the same thing in their own words", () => {
    const en = files["index.en.html"] as string;
    const de = files["index.de.html"] as string;
    expect(en).not.toBe(de);
    expect(en).toContain("temporarily unavailable");
    expect(en).toContain("This page refreshes automatically.");
    expect(de).toContain("vorübergehend nicht erreichbar");
    expect(de).toContain("Diese Seite aktualisiert sich automatisch.");
    expect(en.match(/data-/g)?.length).toBe(de.match(/data-/g)?.length);
  });
});

describe("the stylesheet and the script", () => {
  const css = files["maintenance.css"] as string;
  const script = files["maintenance.js"] as string;

  it("have no em dash or dash used as a pause", () => {
    expect(css).not.toMatch(/[—–]/);
    expect(script).not.toMatch(/[—–]/);
  });

  it("are plain ES2019 without a module system", () => {
    expect(script).not.toMatch(/\bimport\s*[({]|\bexport\s/);
    expect(script).not.toMatch(/\?\?|\?\.(?!\d)/);
    expect(script).not.toMatch(/\bBigInt\b|\bimport\.meta\b/);
    expect(
      () => new Function(script.replace(/MaintenanceClient\.bootstrap\(\);\s*$/, "")),
    ).not.toThrow();
    expect(script.trimEnd().endsWith("MaintenanceClient.bootstrap();")).toBe(true);
  });

  it("make no request to anything but the edge's own status and the api's readiness", () => {
    const urls = [...script.matchAll(/["'`](\/[A-Za-z0-9_./-]+|https?:\/\/[^"'`]+)["'`]/g)].map(
      (match) => match[1],
    );
    expect(urls.filter((url) => /^https?:/.test(url ?? ""))).toEqual([]);
    expect(script).toContain("/_maintenance/status");
    expect(script).toContain("/readyz");
  });

  it("stay small", () => {
    expect(script.length).toBeLessThan(9_000);
    expect(css.length).toBeLessThan(9_000);
  });

  it("keep both light and dark text readable on their backgrounds", () => {
    // Contrast of the muted text (the least contrasty text) against the card, per scheme.
    const luminance = (hex: string) => {
      const [red, green, blue] = [1, 3, 5].map((index) => {
        const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const contrast = (a: string, b: string) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (light + 0.05) / (dark + 0.05);
    };
    const light = css.split("@media (prefers-color-scheme: dark)")[0] as string;
    const dark = css.split("@media (prefers-color-scheme: dark)")[1] as string;
    const variable = (block: string, name: string) =>
      new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(block)?.[1] as string;
    for (const [scheme, block] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      const card = variable(block, "card");
      for (const name of ["fg", "muted", "ok", "info", "err"]) {
        expect(contrast(variable(block, name), card), `${scheme} ${name}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });
});

describe("branding", () => {
  it("builds with the default product name unless the build sets one", () => {
    expect(buildProductName({})).toBe(DEFAULT_PRODUCT_NAME);
    expect(buildProductName({ RESTOW_PRODUCT_NAME: "   " })).toBe(DEFAULT_PRODUCT_NAME);
    expect(buildProductName({ RESTOW_PRODUCT_NAME: "  Acme \n Backup " })).toBe("Acme Backup");
    expect(loadPageTexts(ROOT, "en", "Acme Backup").product).toBe("Acme Backup");
  });

  it("takes any product name and names no product itself", () => {
    const texts = { ...loadPageTexts(ROOT, "en"), product: "Acme Restore" };
    const html = renderPage(texts);
    expect(html).toContain("Acme Restore");
    expect(html).not.toMatch(/restow/i);
    expect(files["maintenance.css"]).not.toMatch(/restow/i);
    expect(files["maintenance.js"]).not.toMatch(/restow/i);
  });

  it("escapes a product name that contains markup", () => {
    const html = renderPage({ ...loadPageTexts(ROOT, "en"), product: '<b onclick="x">&' });
    expect(html).not.toContain('<b onclick="x">');
    expect(html).toContain("&lt;b onclick=&quot;x&quot;&gt;&amp;");
  });

  it("keeps the template sources free of the product name", () => {
    const directory = path.join(ROOT, "vite/maintenance-page");
    for (const name of readdirSync(directory).filter((file) =>
      /^(client|template)\.ts$/.test(file),
    )) {
      expect(readFileSync(path.join(directory, name), "utf8"), name).not.toMatch(/restow/i);
    }
  });
});

describe("the plugin", () => {
  it("emits the files into dist/maintenance/ on a production build", async () => {
    const plugin = maintenancePagePlugin();
    expect(plugin.apply).toBe("build");
    const emitted: { fileName: string; source: string; type: string }[] = [];
    (plugin.configResolved as (config: { root: string }) => void)({ root: ROOT });
    await (plugin.generateBundle as (this: unknown) => Promise<void>).call({
      emitFile: (file: { fileName: string; source: string; type: string }) => emitted.push(file),
    });
    expect(emitted.map((file) => file.fileName).sort()).toEqual([
      "maintenance/index.de.html",
      "maintenance/index.en.html",
      "maintenance/maintenance.css",
      "maintenance/maintenance.js",
    ]);
    expect(emitted.every((file) => file.type === "asset")).toBe(true);
  });

  it("is part of the Vite configuration", () => {
    const config = readFileSync(path.join(ROOT, "vite.config.ts"), "utf8");
    expect(config).toContain('from "./vite/maintenance-page"');
    expect(config).toMatch(/plugins:\s*\[[^\]]*maintenancePagePlugin\(\)/);
  });

  it("refuses to build a page with a missing text instead of shipping a hole", () => {
    expect(() => loadPageTexts(ROOT, "xx")).toThrow();
  });
});
