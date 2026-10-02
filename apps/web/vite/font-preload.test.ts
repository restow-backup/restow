import { describe, expect, it } from "vitest";

import { PRELOADED_WEIGHTS, assetUrl, fontPreloadPlugin, fontPreloadTags } from "./font-preload";

/**
 * The preload links of the first-paint fonts: which of the bundle's files they
 * name, what the tags look like, and that a renamed font file fails the build.
 */

/** What a production build of the app emits (names as in dist/assets, hashes shortened). */
const BUNDLE = [
  "assets/index-Dstg7Oic.js",
  "assets/index-rE8H_7NA.css",
  "assets/vendor-react-74vvBLZO.js",
  "assets/ibm-plex-mono-latin-400-normal-DMJ8VG8y.woff2",
  "assets/ibm-plex-mono-latin-500-normal-DSY6xOcd.woff2",
  "assets/ibm-plex-mono-latin-600-normal-BgRBH3aV.woff2",
  "assets/ibm-plex-mono-latin-ext-400-normal-BmRBH3aV.woff2",
  "assets/inter-tight-latin-400-normal-iW8qmuJY.woff2",
  "assets/inter-tight-latin-500-normal-BFXNXuvF.woff2",
  "assets/inter-tight-latin-600-normal-BgSTtRxb.woff2",
  "assets/inter-tight-latin-700-normal-BZKd_v_8.woff2",
  "assets/inter-tight-latin-ext-400-normal-DN7wyBvd.woff2",
  "assets/inter-tight-latin-ext-500-normal-D3akd6m-.woff2",
  "assets/inter-tight-latin-ext-600-normal-BgMgWFts.woff2",
  "assets/inter-tight-latin-ext-700-normal-BpKPOkj3.woff2",
  "maintenance/index.en.html",
];

const hrefs = (tags: ReturnType<typeof fontPreloadTags>) => tags.map((tag) => tag.attrs?.href);

describe("fontPreloadTags", () => {
  it("names the latin files of Inter Tight 400, 500 and 600 and nothing else", () => {
    expect(PRELOADED_WEIGHTS).toEqual([400, 500, 600]);
    expect(hrefs(fontPreloadTags(BUNDLE))).toEqual([
      "/assets/inter-tight-latin-400-normal-iW8qmuJY.woff2",
      "/assets/inter-tight-latin-500-normal-BFXNXuvF.woff2",
      "/assets/inter-tight-latin-600-normal-BgSTtRxb.woff2",
    ]);
  });

  it("never picks the latin-ext subset, the bold weight or IBM Plex Mono", () => {
    const all = hrefs(fontPreloadTags(BUNDLE)).join("\n");
    expect(all).not.toContain("latin-ext");
    expect(all).not.toContain("-700-");
    expect(all).not.toContain("ibm-plex-mono");
  });

  it("writes a preload link for a font: woff2 type, anonymous CORS, into the head", () => {
    for (const tag of fontPreloadTags(BUNDLE)) {
      expect(tag.tag).toBe("link");
      expect(tag.injectTo).toBe("head");
      expect(tag.attrs).toMatchObject({
        rel: "preload",
        as: "font",
        type: "font/woff2",
        // Fonts are fetched in CORS mode even from the same origin; without it the preload is wasted.
        crossorigin: true,
      });
    }
  });

  it("follows the configured base, and keeps same-origin paths", () => {
    expect(hrefs(fontPreloadTags(BUNDLE, "/restow/"))[0]).toBe(
      "/restow/assets/inter-tight-latin-400-normal-iW8qmuJY.woff2",
    );
    expect(hrefs(fontPreloadTags(BUNDLE, "/restow"))[0]).toBe(
      "/restow/assets/inter-tight-latin-400-normal-iW8qmuJY.woff2",
    );
    expect(assetUrl("", "assets/a.woff2")).toBe("assets/a.woff2");
    expect(assetUrl("./", "assets/a.woff2")).toBe("assets/a.woff2");
    expect(assetUrl("https://cdn.example/", "assets/a.woff2")).toBe(
      "https://cdn.example/assets/a.woff2",
    );
  });

  it("fails the build when a face is missing or ambiguous, rather than losing the preload quietly", () => {
    const withoutMedium = BUNDLE.filter((name) => !name.includes("latin-500-normal"));
    expect(() => fontPreloadTags(withoutMedium)).toThrow(/Inter Tight latin 500, found 0/);
    const twice = [...BUNDLE, "assets/inter-tight-latin-600-normal-Other123.woff2"];
    expect(() => fontPreloadTags(twice)).toThrow(/Inter Tight latin 600, found 2/);
    expect(() => fontPreloadTags(["assets/index.js"])).toThrow(/Font preload/);
  });
});

describe("fontPreloadPlugin", () => {
  const plugin = fontPreloadPlugin();
  const hook = plugin.transformIndexHtml as {
    order?: string;
    handler: (
      html: string,
      context: { path: string; filename: string; bundle?: Record<string, unknown> },
    ) => unknown;
  };
  const context = (bundle?: Record<string, unknown>) => ({
    path: "/index.html",
    filename: "index.html",
    ...(bundle ? { bundle } : {}),
  });

  it("only runs in a production build, after Vite has put its own tags in", () => {
    expect(plugin.apply).toBe("build");
    expect(hook.order).toBe("post");
  });

  it("returns the three links for the bundle it is handed", () => {
    const bundle = Object.fromEntries(BUNDLE.map((name) => [name, {}]));
    const tags = hook.handler("<html></html>", context(bundle)) as ReturnType<
      typeof fontPreloadTags
    >;
    expect(hrefs(tags)).toEqual(hrefs(fontPreloadTags(BUNDLE)));
  });

  it("uses the base of the resolved config", () => {
    const withBase = fontPreloadPlugin();
    (withBase.configResolved as (config: { base: string }) => void)({ base: "/app/" });
    const bundle = Object.fromEntries(BUNDLE.map((name) => [name, {}]));
    const handler = (withBase.transformIndexHtml as typeof hook).handler;
    const tags = handler("<html></html>", context(bundle)) as ReturnType<typeof fontPreloadTags>;
    expect(hrefs(tags)[2]).toBe("/app/assets/inter-tight-latin-600-normal-BgSTtRxb.woff2");
  });

  it("leaves the page alone when there is no bundle (a dev server)", () => {
    expect(hook.handler("<html></html>", context())).toBeUndefined();
  });
});
