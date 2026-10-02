import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Fonts are always self-hosted: the edge's Content-Security-Policy allows
 * `font-src 'self'`, and an installation must not call a font service or CDN.
 * These checks keep the stylesheets, the document and the sources free of any
 * external font reference and make sure every face points at a real file of
 * the @fontsource packages (Vite bundles it into /assets).
 */

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const srcRoot = join(webRoot, "src");

const read = (path: string) => readFileSync(join(webRoot, path), "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every file under `dir` with one of the extensions, tests excluded. */
function sources(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sources(path, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext)) && !/\.test\./.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

const stylesheets = sources(srcRoot, [".css"]);
const fontsCss = stripComments(read("src/fonts.css"));

const FONT_SERVICES =
  /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|fast\.fonts\.net|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com/i;

describe("self-hosted fonts", () => {
  it("finds the stylesheets", () => {
    expect(stylesheets.map((path) => path.slice(srcRoot.length + 1))).toEqual(
      expect.arrayContaining(["fonts.css", "index.css"]),
    );
  });

  it("no stylesheet references a remote URL, a font service or an inlined font", () => {
    for (const path of stylesheets) {
      const css = stripComments(readFileSync(path, "utf8"));
      expect(css, path).not.toMatch(/https?:\/\//i);
      expect(css, path).not.toMatch(/url\(\s*["']?\/\//);
      expect(css, path).not.toMatch(FONT_SERVICES);
      expect(css, path).not.toMatch(/@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i);
      expect(css, path).not.toMatch(/data:(?:font|application\/(?:font|x-font|octet-stream))/i);
    }
  });

  it("the document and the TypeScript sources name no font service or CDN", () => {
    const files = [join(webRoot, "index.html"), ...sources(srcRoot, [".ts", ".tsx"])];
    for (const path of files) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(FONT_SERVICES);
    }
    expect(read("index.html")).not.toMatch(
      /<link[^>]+rel=["'](?:stylesheet|preconnect|dns-prefetch)/i,
    );
  });

  it("every face is a woff2 file of an installed @fontsource package", () => {
    const urls = [...fontsCss.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map(([, url]) => url);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, "face source").toMatch(
        /^@fontsource\/(?:inter-tight|ibm-plex-mono)\/files\/[\w-]+\.woff2$/,
      );
      const file = join(webRoot, "node_modules", url ?? "");
      expect(existsSync(file), `${url} is not installed`).toBe(true);
    }
  });

  it("declares upright latin and latin-ext faces for the weights the interface uses", () => {
    const faces = [...fontsCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => body ?? "");
    const declared = (family: string) =>
      faces
        .filter((face) => face.includes(`font-family: "${family}"`))
        .map((face) => {
          const weight = /font-weight:\s*(\d+)/.exec(face)?.[1];
          const subset = /-(latin(?:-ext)?)-\d+-normal\.woff2/.exec(face)?.[1];
          expect(face).toMatch(/font-style:\s*normal/);
          expect(face).toMatch(/font-display:\s*swap/);
          expect(face).toMatch(/unicode-range:/);
          return `${subset}-${weight}`;
        })
        .sort();
    expect(declared("Inter Tight")).toEqual(
      ["latin", "latin-ext"].flatMap((s) => [400, 500, 600, 700].map((w) => `${s}-${w}`)).sort(),
    );
    expect(declared("IBM Plex Mono")).toEqual(
      ["latin", "latin-ext"].flatMap((s) => [400, 500, 600].map((w) => `${s}-${w}`)).sort(),
    );
  });

  it("makes Inter Tight the base font and IBM Plex Mono the monospace font", () => {
    const css = stripComments(read("src/index.css"));
    const theme = /@theme\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(theme).toMatch(/--font-sans:\s*"Inter Tight",/);
    expect(theme).toMatch(/--font-mono:\s*"IBM Plex Mono",/);
  });
});
