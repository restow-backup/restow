import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { type ChartStatusTone, STATUS_CHART_COLOR } from "../kit/chart-colors.js";
import alertSource from "./alert.tsx?raw";
import badgeSource from "./badge.tsx?raw";

// Read from disk: Vitest's CSS pipeline turns stylesheet imports (even `?raw`) into empty strings.
const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

/**
 * Guards the colour contract of index.css with the same maths a browser uses:
 * OKLCH -> sRGB, alpha compositing in sRGB, WCAG 2 contrast. Distinctness of
 * the chart palettes is measured in OKLab (Delta E x 100) for normal vision and
 * under protanopia/deuteranopia (Machado, Oliveira & Fernandes 2009, severity
 * 1.0). Chart series may only take their colour from those palettes.
 */

type Rgb = readonly [number, number, number];
type Tokens = ReadonlyMap<string, string>;

const TONES = ["success", "warning", "destructive", "info"] as const;
const CHART_SLOTS = [1, 2, 3, 4, 5] as const;
const STATUS_CHART_TONES = Object.keys(STATUS_CHART_COLOR) as ChartStatusTone[];
// Surfaces a status badge or alert sits on: cards, the page, muted panels and hovered rows.
const SURFACES = ["card", "background", "muted"] as const;

const TEXT_MIN = 4.5;
const CHART_CONTRAST_MIN = 3;
const CHART_DELTA_E_MIN = 15;
const CHART_CVD_DELTA_E_MIN = 8;

// -- parsing ----------------------------------------------------------------------

function declarations(selector: string): Map<string, string> {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m").exec(source);
  if (!match?.[1]) {
    throw new Error(`index.css has no top-level "${selector}" block`);
  }
  const tokens = new Map<string, string>();
  for (const [, name, value] of match[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    if (name && value) {
      tokens.set(name, value.trim());
    }
  }
  return tokens;
}

const light: Tokens = declarations(":root");
const darkOverrides: Tokens = declarations(".dark");
const dark: Tokens = new Map([...light, ...darkOverrides]);
const MODES = [
  ["light", light],
  ["dark", dark],
] as const;

function parseOklch(value: string): { lch: Rgb; alpha: number } {
  const match = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(
    value,
  );
  if (!match) {
    throw new Error(`not an oklch() colour: ${value}`);
  }
  const [, l, lPercent, c, h, a, aPercent] = match;
  const lightness = Number(l) / (lPercent ? 100 : 1);
  const alpha = a === undefined ? 1 : Number(a) / (aPercent ? 100 : 1);
  return { lch: [lightness, Number(c), Number(h)], alpha };
}

function token(tokens: Tokens, name: string): Rgb {
  const value = tokens.get(name);
  if (value === undefined) {
    throw new Error(`token --${name} is not defined`);
  }
  const { lch, alpha } = parseOklch(value);
  expect(alpha, `--${name} must be opaque`).toBe(1);
  return oklchToSrgb(lch);
}

// -- colour maths -------------------------------------------------------------------

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * clamp01(c) ** (1 / 2.4) - 0.055;

/** OKLCH -> gamma-encoded sRGB, clamped to the displayable gamut like a browser. */
function oklchToSrgb([l, c, h]: Rgb): Rgb {
  const hue = (h * Math.PI) / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ] as const;
  return [
    fromLinear(clamp01(linear[0])),
    fromLinear(clamp01(linear[1])),
    fromLinear(clamp01(linear[2])),
  ];
}

/** `bg-<tone>/<alpha>` over an opaque surface: alpha compositing in gamma-encoded sRGB. */
function composite(color: Rgb, alpha: number, surface: Rgb): Rgb {
  return [
    color[0] * alpha + surface[0] * (1 - alpha),
    color[1] * alpha + surface[1] * (1 - alpha),
    color[2] * alpha + surface[2] * (1 - alpha),
  ];
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

function oklabFromLinear([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

type Vision = "normal" | keyof typeof MACHADO;

function perceived(color: Rgb, vision: Vision): Rgb {
  const linear: Rgb = [toLinear(color[0]), toLinear(color[1]), toLinear(color[2])];
  if (vision === "normal") {
    return oklabFromLinear(linear);
  }
  const [r, g, b] = linear;
  const rows = MACHADO[vision];
  const row = (i: 0 | 1 | 2) => clamp01(rows[i][0] * r + rows[i][1] * g + rows[i][2] * b);
  return oklabFromLinear([row(0), row(1), row(2)]);
}

function deltaE(a: Rgb, b: Rgb, vision: Vision): number {
  const [x, y] = [perceived(a, vision), perceived(b, vision)];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** Every `bg-<tone>/<n>` tint used in a component source, as fractions (0.15). */
function tintAlphas(source: string, tone: string): number[] {
  const found = [...source.matchAll(new RegExp(`\\bbg-${tone}/(\\d+)\\b`, "g"))].map(
    ([, percent]) => Number(percent) / 100,
  );
  return [...new Set(found)];
}

/** Every pair of a palette stays apart for normal and colour-blind vision. */
function expectDistinguishable(names: readonly string[]): void {
  for (const [mode, tokens] of MODES) {
    names.forEach((a, index) => {
      for (const b of names.slice(index + 1)) {
        const [x, y] = [token(tokens, a), token(tokens, b)];
        const pair = `${mode}: ${a} / ${b}`;
        expect(deltaE(x, y, "normal"), pair).toBeGreaterThanOrEqual(CHART_DELTA_E_MIN);
        expect(deltaE(x, y, "protan"), `${pair} (protan)`).toBeGreaterThanOrEqual(
          CHART_CVD_DELTA_E_MIN,
        );
        expect(deltaE(x, y, "deutan"), `${pair} (deutan)`).toBeGreaterThanOrEqual(
          CHART_CVD_DELTA_E_MIN,
        );
      }
    });
  }
}

/** The token name behind a `var(--name)` reference. */
function varName(reference: string): string {
  const match = /^var\(--([\w-]+)\)$/.exec(reference);
  if (!match?.[1]) {
    throw new Error(`not a var() reference: ${reference}`);
  }
  return match[1];
}

// -- the contract ---------------------------------------------------------------------

describe("status text tokens", () => {
  it("defines every tone, its foreground and its text-safe token in both themes", () => {
    for (const tone of TONES) {
      for (const suffix of ["", "-foreground", "-text"]) {
        expect(light.has(`${tone}${suffix}`), `:root --${tone}${suffix}`).toBe(true);
        expect(darkOverrides.has(`${tone}${suffix}`), `.dark --${tone}${suffix}`).toBe(true);
      }
    }
  });

  for (const [component, source] of [
    ["badge", badgeSource],
    ["alert", alertSource],
  ] as const) {
    for (const tone of TONES) {
      it(`${component} ${tone}: text reaches ${TEXT_MIN}:1 on its tint in light and dark`, () => {
        const alphas = tintAlphas(source, tone);
        expect(alphas.length, `${component}.tsx uses no bg-${tone}/<alpha> tint`).toBeGreaterThan(
          0,
        );
        for (const [mode, tokens] of MODES) {
          for (const alpha of alphas) {
            for (const surface of SURFACES) {
              const background = composite(token(tokens, tone), alpha, token(tokens, surface));
              const ratio = contrast(token(tokens, `${tone}-text`), background);
              expect(
                ratio,
                `${mode}: --${tone}-text on bg-${tone}/${alpha * 100} over --${surface}`,
              ).toBeGreaterThanOrEqual(TEXT_MIN);
            }
          }
        }
      });
    }
  }

  it(`muted badge text reaches ${TEXT_MIN}:1 in light and dark`, () => {
    expect(badgeSource).toMatch(/muted: "bg-muted text-muted-foreground"/);
    for (const [mode, tokens] of MODES) {
      const ratio = contrast(token(tokens, "muted-foreground"), token(tokens, "muted"));
      expect(ratio, `${mode}: --muted-foreground on --muted`).toBeGreaterThanOrEqual(TEXT_MIN);
    }
  });
});

describe("Soon badge of upcoming menu entries", () => {
  // components/layout/soon-badge.tsx: the warning badge (amber, never green)
  // on the sidebar, a hovered or active sidebar entry and an open menu.
  const BADGE_SURFACES = ["sidebar", "sidebar-accent", "popover", "accent"] as const;

  it(`text reaches ${TEXT_MIN}:1 on its tint over every surface it sits on, in light and dark`, () => {
    const alphas = tintAlphas(badgeSource, "warning");
    expect(alphas.length).toBeGreaterThan(0);
    for (const [mode, tokens] of MODES) {
      for (const alpha of alphas) {
        for (const surface of BADGE_SURFACES) {
          const background = composite(token(tokens, "warning"), alpha, token(tokens, surface));
          const ratio = contrast(token(tokens, "warning-text"), background);
          expect(
            ratio,
            `${mode}: --warning-text on bg-warning/${alpha * 100} over --${surface}`,
          ).toBeGreaterThanOrEqual(TEXT_MIN);
        }
      }
    }
  });
});

describe("chart palette", () => {
  it("defines chart-1 to chart-5 in both themes", () => {
    for (const slot of CHART_SLOTS) {
      expect(light.has(`chart-${slot}`)).toBe(true);
      expect(darkOverrides.has(`chart-${slot}`)).toBe(true);
    }
  });

  it(`every slot reaches ${CHART_CONTRAST_MIN}:1 against --card in light and dark`, () => {
    for (const [mode, tokens] of MODES) {
      for (const slot of CHART_SLOTS) {
        const ratio = contrast(token(tokens, `chart-${slot}`), token(tokens, "card"));
        expect(ratio, `${mode}: --chart-${slot} on --card`).toBeGreaterThanOrEqual(
          CHART_CONTRAST_MIN,
        );
      }
    }
  });

  it("every pair stays distinguishable for normal and colour-blind vision", () => {
    expectDistinguishable(CHART_SLOTS.map((slot) => `chart-${slot}`));
  });
});

describe("status chart palette", () => {
  // Status-coded series (outcomes, readiness) are stacked next to each other,
  // so the four tones must hold up as graphics and apart from each other.
  const names = STATUS_CHART_TONES.map((tone) => varName(STATUS_CHART_COLOR[tone]));

  it("maps every status tone to its own chart token, defined in both themes", () => {
    expect([...STATUS_CHART_TONES].sort()).toEqual([
      "destructive",
      "info",
      "muted",
      "success",
      "warning",
    ]);
    for (const tone of STATUS_CHART_TONES) {
      expect(varName(STATUS_CHART_COLOR[tone])).toBe(`chart-${tone}`);
      expect(light.has(`chart-${tone}`), `:root --chart-${tone}`).toBe(true);
      expect(darkOverrides.has(`chart-${tone}`), `.dark --chart-${tone}`).toBe(true);
    }
  });

  it(`every tone reaches ${CHART_CONTRAST_MIN}:1 against --card in light and dark`, () => {
    for (const [mode, tokens] of MODES) {
      for (const name of names) {
        const ratio = contrast(token(tokens, name), token(tokens, "card"));
        expect(ratio, `${mode}: --${name} on --card`).toBeGreaterThanOrEqual(CHART_CONTRAST_MIN);
      }
    }
  });

  it("every pair stays distinguishable for normal and colour-blind vision", () => {
    expectDistinguishable(names);
  });
});

describe("chart series colours", () => {
  const sources = import.meta.glob<string>(
    [
      "../../features/**/*.tsx",
      "../../features/**/*.ts",
      "../kit/**/*.tsx",
      "../kit/**/*.ts",
      "!../../**/*.test.*",
    ],
    { query: "?raw", import: "default", eager: true },
  );
  // Files that build a recharts config (`{ label, color }` per series).
  const charts = Object.entries(sources).filter(([, source]) => source.includes("ChartConfig"));
  const CHART_COLOUR = /^var\(--chart-(?:[1-5]|success|warning|destructive|muted)\)$/;

  it("finds the chart configs", () => {
    expect(charts.length, "the glob no longer reaches the chart sources").toBeGreaterThan(3);
  });

  it("come from the chart palettes, never from the UI tones or raw colours", () => {
    for (const [path, source] of charts) {
      for (const [, , value] of source.matchAll(/\bcolor:\s*(["'`])([^"'`]*)\1/g)) {
        expect(value, `${path}: series colour ${value}`).toMatch(CHART_COLOUR);
      }
    }
  });
});

describe("page before the theme module runs", () => {
  // The unclassed <html> under a dark system preference (see index.css).
  const PRE_THEME_SELECTOR = ":root:not(.light):not(.dark)";

  function preThemeBlock(): Map<string, string> {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const media = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*([^{]+)\{([^}]*)\}\s*\}/.exec(
      source,
    );
    expect(media, "index.css has no prefers-color-scheme: dark fallback").not.toBeNull();
    expect(media?.[1]?.trim()).toBe(PRE_THEME_SELECTOR);
    const tokens = new Map<string, string>();
    for (const [, name, value] of (media?.[2] ?? "").matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
      if (name && value) {
        tokens.set(name, value.trim());
      }
    }
    return tokens;
  }

  it("paints the empty page with the dark surface on a dark system", () => {
    const block = preThemeBlock();
    expect(block.get("color-scheme")).toBe("dark");
    for (const name of ["background", "foreground"]) {
      expect(block.get(`--${name}`), `--${name}`).toBe(darkOverrides.get(name));
    }
  });
});

describe("component sources", () => {
  const sources = import.meta.glob<string>(["./**/*.tsx", "./**/*.ts", "!./**/*.test.*"], {
    query: "?raw",
    import: "default",
    eager: true,
  });

  it("finds the primitives", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(30);
  });

  it("use design tokens, never raw hex colours", () => {
    for (const [path, source] of Object.entries(sources)) {
      // Attribute selectors that match recharts' own default strokes
      // (`[stroke='#ccc']`) select elements; they do not set a colour.
      const withoutSelectors = source.replace(/\[[\w-]+='#[0-9a-fA-F]{3,8}'\]/g, "");
      expect(withoutSelectors, path).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
