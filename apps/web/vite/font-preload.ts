import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin } from "vite";

/**
 * Build-time `<link rel="preload" as="font">` for the faces the first paint
 * needs.
 *
 * The page sets everything in Inter Tight, mostly at weights 400, 500 and 600,
 * and the browser only learns about those files after it has downloaded and
 * parsed the stylesheet that declares them. Preloading the latin subset of the
 * three weights starts the transfer together with the stylesheet, so the first
 * paint does not wait for a second round trip (and shows less of the fallback
 * face). Everything else (700 for the wordmark, latin-ext, IBM Plex Mono) is
 * fetched on demand as before.
 *
 * The file names carry a content hash that only the bundle knows, so the links
 * are written into `index.html` when the build has emitted the assets. Fonts
 * are fetched in anonymous CORS mode even from the same origin, so a preload
 * without `crossorigin` would be fetched twice and never used. The files are
 * served from the installation itself (`font-src 'self'` of the edge's
 * Content-Security-Policy), as before.
 */

/** The faces to preload: weight of Inter Tight, latin subset only. */
export const PRELOADED_WEIGHTS = [400, 500, 600] as const;

/** A bundled `inter-tight-latin-<weight>-normal-<hash>.woff2`, never the `latin-ext` subset. */
function faceFile(weight: number): RegExp {
  return new RegExp(`(?:^|/)inter-tight-latin-${weight}-normal-[\\w-]+\\.woff2$`);
}

/** The URL of an emitted file under the configured base (`/` for an installation's root). */
export function assetUrl(base: string, fileName: string): string {
  if (base === "" || base === "./") {
    return fileName;
  }
  return `${base.endsWith("/") ? base : `${base}/`}${fileName}`;
}

/**
 * The preload tags for the bundle's files, in weight order. Throws when a face
 * is missing: a font package that renamed its files must fail the build, not
 * quietly lose the preload.
 */
export function fontPreloadTags(fileNames: readonly string[], base = "/"): HtmlTagDescriptor[] {
  return PRELOADED_WEIGHTS.map((weight) => {
    const matches = fileNames.filter((name) => faceFile(weight).test(name));
    if (matches.length !== 1) {
      throw new Error(
        `Font preload: expected one bundled file for Inter Tight latin ${weight}, found ${matches.length}`,
      );
    }
    return {
      tag: "link",
      attrs: {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        crossorigin: true,
        href: assetUrl(base, matches[0] as string),
      },
      injectTo: "head",
    };
  });
}

/** Adds the preload links to `index.html` of a production build. */
export function fontPreloadPlugin(): Plugin {
  let base = "/";
  return {
    name: "font-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      // After Vite has injected its own tags, so the hashed asset names are in the bundle.
      order: "post",
      handler(_html: string, context: IndexHtmlTransformContext) {
        if (!context.bundle) {
          return undefined;
        }
        return fontPreloadTags(Object.keys(context.bundle), base);
      },
    },
  };
}
