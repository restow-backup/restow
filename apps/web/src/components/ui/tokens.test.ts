import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { type ChartStatusTone, STATUS_CHART_COLOR } from "../kit/chart-colors.js";
import alertSource from "./alert.tsx?raw";
import badgeSource from "./badge.tsx?raw";
import buttonSource from "./button.tsx?raw";
import sidebarSource from "./sidebar.tsx?raw";

// Read from disk: Vitest's CSS pipeline turns stylesheet imports (even `?raw`) into empty strings.
const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

/**
 * Guards the colour contract of index.css with the same maths a browser uses:
 * OKLCH -> sRGB, alpha compositing in sRGB, WCAG 2 contrast. Distinctness of
 * the chart palettes is measured in OKLab (Delta E x 100) for normal vision and
 * under protanopia/deuteranopia (Machado, Oliveira & Fernandes 2009, severity
 * 1.0). Chart series may only take their colour from those palettes.
 *
 * There are four looks: the colour schemes Restow and Neutral, each in light
 * and dark. The contrast contract holds for all four. A look's tokens are what
 * the cascade makes of them for `<html>`: `:root`, then `.dark`, then the
 * Neutral blocks (their attribute selector outranks both), the dark Neutral
 * block last.
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

const NEUTRAL_LIGHT_SELECTOR = ':root[data-palette="neutral"]';
const NEUTRAL_DARK_SELECTOR = '.dark[data-palette="neutral"]';

const light: Tokens = declarations(":root");
const darkOverrides: Tokens = declarations(".dark");
const neutralLightOverrides: Tokens = declarations(NEUTRAL_LIGHT_SELECTOR);
const neutralDarkOverrides: Tokens = declarations(NEUTRAL_DARK_SELECTOR);
const dark: Tokens = new Map([...light, ...darkOverrides]);
// The attribute selector (0,2,0) outranks `.dark` (0,1,0), so the light Neutral
// block lands on top of the dark brand tokens, and the dark Neutral block, later
// in the file, on top of that.
const neutralLight: Tokens = new Map([...light, ...neutralLightOverrides]);
const neutralDark: Tokens = new Map([
  ...light,
  ...darkOverrides,
  ...neutralLightOverrides,
  ...neutralDarkOverrides,
]);
const BRAND_LOOKS = [
  ["Restow light", light],
  ["Restow dark", dark],
] as const;
const NEUTRAL_LOOKS = [
  ["Neutral light", neutralLight],
  ["Neutral dark", neutralDark],
] as const;
const LOOKS = [...BRAND_LOOKS, ...NEUTRAL_LOOKS] as const;

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

/** gamma-encoded sRGB to `#RRGGBB`, the way an 8-bit display shows it. */
function toHex(color: Rgb): string {
  return `#${color
    .map((channel) =>
      Math.round(clamp01(channel) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase()}`;
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
  for (const [look, tokens] of LOOKS) {
    names.forEach((a, index) => {
      for (const b of names.slice(index + 1)) {
        const [x, y] = [token(tokens, a), token(tokens, b)];
        const pair = `${look}: ${a} / ${b}`;
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

describe("brand palette", () => {
  // Brand guide, section 4. The tokens are OKLCH conversions of these hex values.
  const NILE = "#0F1B2D";
  const LIMESTONE = "#F4F5F7";
  const LAPIS = "#2B4C9B";
  const LAPIS_DARK = "#9DB4E6";
  const GREEN = "#2DA37A";
  const WARNING = "#D69E2E";
  // The brand red is a swatch for fills; the interface's --destructive is the
  // step darker below (see "destructive red"). Dark mode uses the lifted red.
  const ERROR_UI = "#C63437";
  const hex = (tokens: Tokens, name: string) => toHex(token(tokens, name));

  it("uses Limestone and Nile for the page and the text, Nile and Limestone in dark", () => {
    expect(hex(light, "background")).toBe(LIMESTONE);
    expect(hex(light, "foreground")).toBe(NILE);
    expect(hex(dark, "background")).toBe(NILE);
    expect(hex(dark, "foreground")).toBe(LIMESTONE);
  });

  it("uses Lapis for the primary, the ring, the sidebar primary and information", () => {
    for (const name of ["primary", "ring", "sidebar-primary", "sidebar-ring", "info"]) {
      expect(hex(light, name), `light --${name}`).toBe(LAPIS);
      expect(hex(dark, name), `dark --${name}`).toBe(LAPIS_DARK);
    }
  });

  it("uses the brand green for success only, the brand amber, and the contrast-safe red in light", () => {
    expect(hex(light, "success")).toBe(GREEN);
    expect(hex(dark, "success")).toBe(GREEN);
    expect(hex(light, "warning")).toBe(WARNING);
    expect(hex(dark, "warning")).toBe(WARNING);
    expect(hex(light, "destructive")).toBe(ERROR_UI);
    // Green is a status colour: no other token may take it, in any colour scheme.
    for (const [look, tokens] of LOOKS) {
      for (const [name, value] of tokens) {
        if (name === "success" || !value.startsWith("oklch(") || value.includes("/")) {
          continue;
        }
        expect(toHex(token(tokens, name)), `${look}: --${name}`).not.toBe(GREEN);
      }
    }
  });
});

describe("text on its surface", () => {
  // Every text token on the surface it is set on, in light and dark.
  const PAIRS = [
    ["primary-foreground", "primary"],
    ["foreground", "background"],
    ["foreground", "card"],
    ["foreground", "muted"],
    ["card-foreground", "card"],
    ["popover-foreground", "popover"],
    ["secondary-foreground", "secondary"],
    ["accent-foreground", "accent"],
    ["muted-foreground", "background"],
    ["muted-foreground", "card"],
    ["muted-foreground", "muted"],
    ["sidebar-foreground", "sidebar"],
    ["sidebar-primary-foreground", "sidebar-primary"],
    // The active sidebar entry: Lapis text on a Lapis tint.
    ["sidebar-accent-foreground", "sidebar-accent"],
    // A hovered sidebar entry: the ordinary sidebar text on the neutral hover surface.
    ["sidebar-foreground", "sidebar-hover"],
  ] as const;

  for (const [text, surface] of PAIRS) {
    it(`--${text} on --${surface} reaches ${TEXT_MIN}:1 in both colour schemes, light and dark`, () => {
      for (const [look, tokens] of LOOKS) {
        const ratio = contrast(token(tokens, text), token(tokens, surface));
        expect(ratio, `${look}: --${text} on --${surface}`).toBeGreaterThanOrEqual(TEXT_MIN);
      }
    });
  }
});

describe("destructive red", () => {
  // The brand red (#D64545) is 4.4:1 on white, 4.0:1 on Limestone, 3.8:1 on the
  // muted surface: too little for the red error text (`text-destructive`) and
  // for white text on a destructive button. In the light scheme --destructive
  // is the same hue and chroma one lightness step darker.
  const BRAND_RED = "#D64545";
  const [, brandChroma, brandHue] = parseOklch("oklch(0.597 0.182 24.512)").lch;
  const TEXT_SURFACES = ["card", "popover", "background", "muted"] as const;

  it("keeps the brand red's hue and chroma, only darker", () => {
    expect(toHex(token(light, "destructive"))).not.toBe(BRAND_RED);
    const [lightness, chroma, hue] = parseOklch(light.get("destructive") ?? "").lch;
    expect(hue).toBeCloseTo(brandHue, 0);
    expect(chroma).toBeCloseTo(brandChroma, 3);
    expect(lightness).toBeLessThan(0.597);
    // A step, not a different colour: the darkening stays small.
    expect(0.597 - lightness).toBeLessThan(0.06);
  });

  it(`red text reaches ${TEXT_MIN}:1 on the card, popover, page and muted surface in every look`, () => {
    for (const [look, tokens] of LOOKS) {
      for (const surface of TEXT_SURFACES) {
        const ratio = contrast(token(tokens, "destructive"), token(tokens, surface));
        expect(ratio, `${look}: --destructive on --${surface}`).toBeGreaterThanOrEqual(TEXT_MIN);
      }
    }
  });

  it(`white text on a destructive button reaches ${TEXT_MIN}:1, also on hover (light)`, () => {
    // button.tsx: `bg-destructive text-white hover:bg-destructive/90`
    expect(buttonSource).toMatch(
      /destructive:\s*"bg-destructive text-white hover:bg-destructive\/90/,
    );
    const white: Rgb = [1, 1, 1];
    for (const [look, tokens] of [BRAND_LOOKS[0], NEUTRAL_LOOKS[0]]) {
      const solid = token(tokens, "destructive");
      expect(contrast(white, solid), `${look}: solid`).toBeGreaterThanOrEqual(TEXT_MIN);
      expect(
        contrast(token(tokens, "destructive-foreground"), solid),
        `${look}: foreground`,
      ).toBeGreaterThanOrEqual(TEXT_MIN);
      for (const surface of ["card", "background"] as const) {
        const hover = composite(solid, 0.9, token(tokens, surface));
        expect(contrast(white, hover), `${look}: hover over --${surface}`).toBeGreaterThanOrEqual(
          TEXT_MIN,
        );
      }
    }
  });

  it("red text on the focused menu item's own tint reaches the minimum too (light)", () => {
    // dropdown-menu.tsx: `focus:bg-destructive/10` with `text-destructive`. The dark variant
    // uses its own tint (`dark:...focus:bg-destructive/20`) and is not covered here.
    for (const [look, tokens] of [BRAND_LOOKS[0], NEUTRAL_LOOKS[0]]) {
      const tint = composite(token(tokens, "destructive"), 0.1, token(tokens, "popover"));
      expect(contrast(token(tokens, "destructive"), tint), look).toBeGreaterThanOrEqual(TEXT_MIN);
    }
  });

  it("keeps --destructive-text consistent: the same hue, one step darker than --destructive", () => {
    const hueOf = (tokens: Tokens, name: string) => parseOklch(tokens.get(name) ?? "").lch;
    const [solidL, , solidHue] = hueOf(light, "destructive");
    const [textL, , textHue] = hueOf(light, "destructive-text");
    expect(textHue).toBeCloseTo(solidHue, 0);
    expect(textL).toBeLessThan(solidL);
    // The text tone reads on the tint of the tone (badge, alert) in every look: see "status text tokens".
    const [darkSolidL] = hueOf(dark, "destructive");
    const [darkTextL] = hueOf(dark, "destructive-text");
    expect(darkTextL).toBeGreaterThan(darkSolidL);
  });
});

describe("status text tokens", () => {
  it("defines every tone, its foreground and its text-safe token in both themes", () => {
    for (const tone of TONES) {
      for (const suffix of ["", "-foreground", "-text"]) {
        expect(light.has(`${tone}${suffix}`), `:root --${tone}${suffix}`).toBe(true);
        expect(darkOverrides.has(`${tone}${suffix}`), `.dark --${tone}${suffix}`).toBe(true);
      }
    }
  });

  it("are the same in both colour schemes: the Neutral blocks leave every tone alone", () => {
    for (const [name, value] of light) {
      if (TONES.some((tone) => name.startsWith(tone))) {
        expect(neutralLight.get(name), `Neutral light --${name}`).toBe(value);
        expect(neutralDark.get(name), `Neutral dark --${name}`).toBe(dark.get(name));
      }
    }
  });

  for (const [component, source] of [
    ["badge", badgeSource],
    ["alert", alertSource],
  ] as const) {
    for (const tone of TONES) {
      it(`${component} ${tone}: text reaches ${TEXT_MIN}:1 on its tint in both colour schemes, light and dark`, () => {
        const alphas = tintAlphas(source, tone);
        expect(alphas.length, `${component}.tsx uses no bg-${tone}/<alpha> tint`).toBeGreaterThan(
          0,
        );
        for (const [look, tokens] of LOOKS) {
          for (const alpha of alphas) {
            for (const surface of SURFACES) {
              const background = composite(token(tokens, tone), alpha, token(tokens, surface));
              const ratio = contrast(token(tokens, `${tone}-text`), background);
              expect(
                ratio,
                `${look}: --${tone}-text on bg-${tone}/${alpha * 100} over --${surface}`,
              ).toBeGreaterThanOrEqual(TEXT_MIN);
            }
          }
        }
      });
    }
  }

  it(`muted badge text reaches ${TEXT_MIN}:1 in every look`, () => {
    expect(badgeSource).toMatch(/muted: "bg-muted text-muted-foreground"/);
    for (const [look, tokens] of LOOKS) {
      const ratio = contrast(token(tokens, "muted-foreground"), token(tokens, "muted"));
      expect(ratio, `${look}: --muted-foreground on --muted`).toBeGreaterThanOrEqual(TEXT_MIN);
    }
  });
});

describe("Soon badge of upcoming menu entries", () => {
  // components/layout/soon-badge.tsx: the warning badge (amber, never green)
  // on the sidebar, a hovered or active sidebar entry and an open menu.
  const BADGE_SURFACES = [
    "sidebar",
    "sidebar-hover",
    "sidebar-accent",
    "popover",
    "accent",
  ] as const;

  it(`text reaches ${TEXT_MIN}:1 on its tint over every surface it sits on, in every look`, () => {
    const alphas = tintAlphas(badgeSource, "warning");
    expect(alphas.length).toBeGreaterThan(0);
    for (const [look, tokens] of LOOKS) {
      for (const alpha of alphas) {
        for (const surface of BADGE_SURFACES) {
          const background = composite(token(tokens, "warning"), alpha, token(tokens, surface));
          const ratio = contrast(token(tokens, "warning-text"), background);
          expect(
            ratio,
            `${look}: --warning-text on bg-warning/${alpha * 100} over --${surface}`,
          ).toBeGreaterThanOrEqual(TEXT_MIN);
        }
      }
    }
  });
});

describe("sidebar entries", () => {
  // The entry of the page you are on is a Lapis tint with Lapis text in medium
  // weight; the entry under the pointer is neutral. They must never look alike.
  const menuButton =
    /const sidebarMenuButtonVariants = cva\(\s*"([^"]+)"/.exec(sidebarSource)?.[1] ?? "";

  it("tints the active entry with Lapis, in medium weight", () => {
    expect(menuButton).toContain("data-[active=true]:bg-sidebar-accent");
    expect(menuButton).toContain("data-[active=true]:text-sidebar-accent-foreground");
    expect(menuButton).toContain("data-[active=true]:font-medium");
    // Hovering the active entry leaves it as it is.
    expect(menuButton).toContain("data-[active=true]:hover:bg-sidebar-accent");
    for (const [look, tokens] of BRAND_LOOKS) {
      const hue = (name: string) => parseOklch(tokens.get(name) ?? "").lch;
      const [, chroma] = hue("sidebar-accent");
      // A tint of Lapis (blue hue, visible chroma), not a grey.
      expect(chroma, `${look}: --sidebar-accent chroma`).toBeGreaterThan(0.01);
      expect(hue("sidebar-accent-foreground")[2], `${look}: Lapis hue`).toBeGreaterThan(255);
    }
  });

  it("tints the active entry with a grey in Neutral, a step apart from the hovered entry", () => {
    for (const [look, tokens] of NEUTRAL_LOOKS) {
      const lightness = (name: string) => parseOklch(tokens.get(name) ?? "").lch[0];
      const [, chroma] = parseOklch(tokens.get("sidebar-accent") ?? "").lch;
      expect(chroma, `${look}: --sidebar-accent is grey`).toBeLessThan(0.01);
      expect(
        Math.abs(lightness("sidebar-accent") - lightness("sidebar-hover")),
        `${look}: active against hovered entry`,
      ).toBeGreaterThanOrEqual(0.025);
      // The active entry also differs from its sidebar, so it reads as a mark on the panel.
      expect(
        contrast(token(tokens, "sidebar-accent"), token(tokens, "sidebar")),
        `${look}: active entry against sidebar`,
      ).toBeGreaterThan(1.05);
    }
  });

  it("keeps a hovered entry neutral: the muted surface, never the Lapis tint", () => {
    expect(menuButton).toContain("hover:bg-sidebar-hover");
    expect(menuButton).toContain("hover:text-sidebar-foreground");
    expect(menuButton).not.toMatch(/(?<!data-\[active=true\]:)hover:bg-sidebar-accent/);
    for (const [look, tokens] of LOOKS) {
      expect(tokens.get("sidebar-hover"), `${look}: --sidebar-hover`).toBe(tokens.get("muted"));
      expect(toHex(token(tokens, "sidebar-hover")), look).not.toBe(
        toHex(token(tokens, "sidebar-accent")),
      );
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

  it(`every slot reaches ${CHART_CONTRAST_MIN}:1 against --card in every look`, () => {
    for (const [look, tokens] of LOOKS) {
      for (const slot of CHART_SLOTS) {
        const ratio = contrast(token(tokens, `chart-${slot}`), token(tokens, "card"));
        expect(ratio, `${look}: --chart-${slot} on --card`).toBeGreaterThanOrEqual(
          CHART_CONTRAST_MIN,
        );
      }
    }
  });

  it("is the same in both colour schemes", () => {
    for (const [name, value] of light) {
      if (name.startsWith("chart-")) {
        expect(neutralLight.get(name), `Neutral light --${name}`).toBe(value);
        expect(neutralDark.get(name), `Neutral dark --${name}`).toBe(dark.get(name));
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

  it(`every tone reaches ${CHART_CONTRAST_MIN}:1 against --card in every look`, () => {
    for (const [look, tokens] of LOOKS) {
      for (const name of names) {
        const ratio = contrast(token(tokens, name), token(tokens, "card"));
        expect(ratio, `${look}: --${name} on --card`).toBeGreaterThanOrEqual(CHART_CONTRAST_MIN);
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
  // The unclassed <html> under a dark system preference (see index.css), once
  // for each colour scheme.
  const PRE_THEME_SELECTOR = ":root:not(.light):not(.dark)";
  const PRE_THEME_NEUTRAL_SELECTOR = ':root[data-palette="neutral"]:not(.light):not(.dark)';

  function preThemeBlocks(): Map<string, Map<string, string>> {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks = new Map<string, Map<string, string>>();
    for (const media of source.matchAll(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*([^{]+)\{([^}]*)\}\s*\}/g,
    )) {
      const tokens = new Map<string, string>();
      for (const [, name, value] of (media[2] ?? "").matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
        if (name && value) {
          tokens.set(name, value.trim());
        }
      }
      blocks.set((media[1] ?? "").trim(), tokens);
    }
    return blocks;
  }

  it("has a fallback block per colour scheme and nothing else", () => {
    expect([...preThemeBlocks().keys()]).toEqual([PRE_THEME_SELECTOR, PRE_THEME_NEUTRAL_SELECTOR]);
  });

  it("paints the empty page with the dark surface of the scheme on a dark system", () => {
    const blocks = preThemeBlocks();
    const expectations = [
      [PRE_THEME_SELECTOR, dark],
      [PRE_THEME_NEUTRAL_SELECTOR, neutralDark],
    ] as const;
    for (const [selector, look] of expectations) {
      const block = blocks.get(selector);
      expect(block, selector).toBeDefined();
      expect(block?.get("color-scheme"), selector).toBe("dark");
      for (const name of ["background", "foreground"]) {
        expect(block?.get(`--${name}`), `${selector} --${name}`).toBe(look.get(name));
      }
    }
  });

  it("outranks the light blocks it has to replace", () => {
    // `:root:not(.light):not(.dark)` is (0,3,0) against `:root[data-palette]` (0,2,0): both
    // fallbacks need the extra :not() terms to win on an unclassed <html>.
    for (const selector of [PRE_THEME_SELECTOR, PRE_THEME_NEUTRAL_SELECTOR]) {
      expect(selector.match(/:not\(/g)?.length, selector).toBe(2);
    }
  });
});

describe('colour scheme "Neutral"', () => {
  // The 0.1.0 look: zinc greys with a near-black primary (and the reverse in dark).
  const NEUTRAL_PINS = {
    "Neutral light": {
      background: "#FFFFFF",
      foreground: "#09090B",
      primary: "#18181B",
      "primary-foreground": "#FAFAFA",
      muted: "#F4F4F5",
      border: "#E4E4E7",
    },
    "Neutral dark": {
      background: "#09090B",
      foreground: "#FAFAFA",
      primary: "#E4E4E7",
      "primary-foreground": "#18181B",
      muted: "#27272A",
      card: "#18181B",
    },
  } as const;

  it("has a light and a dark block, selected by an attribute on <html>", () => {
    expect(neutralLightOverrides.size).toBeGreaterThan(20);
    expect(neutralDarkOverrides.size).toBeGreaterThan(20);
  });

  it("sets exactly the same tokens in both blocks, so the dark block replaces every light value", () => {
    // `:root[data-palette]` outranks `.dark`: a token only the light block set would leak into dark.
    expect([...neutralDarkOverrides.keys()].sort()).toEqual(
      [...neutralLightOverrides.keys()].sort(),
    );
  });

  it("overrides only surfaces, text, lines, input, ring, primary and sidebar tokens", () => {
    const OWNED =
      /^(?:background|foreground|card(?:-foreground)?|popover(?:-foreground)?|primary(?:-foreground)?|secondary(?:-foreground)?|muted(?:-foreground)?|accent(?:-foreground)?|border|input|ring|sidebar(?:-[a-z]+)*)$/;
    for (const name of [...neutralLightOverrides.keys(), ...neutralDarkOverrides.keys()]) {
      expect(name, `--${name} is not Neutral's to override`).toMatch(OWNED);
    }
  });

  it("overrides every colour the scheme owns, so no Restow blue shows through", () => {
    const owned = [...light.keys()].filter((name) =>
      /^(?:background|foreground|card|popover|primary|secondary|muted|accent|border|input|ring|sidebar)(?:-[a-z]+)*$/.test(
        name,
      ),
    );
    // sidebar-width and friends are sizes, not colours.
    const colours = owned.filter((name) => !/^sidebar-width/.test(name));
    for (const name of colours) {
      expect(neutralLightOverrides.has(name), `Neutral light misses --${name}`).toBe(true);
      expect(neutralDarkOverrides.has(name), `Neutral dark misses --${name}`).toBe(true);
    }
  });

  it("has no Lapis in its surfaces, text and primary: every value is a grey", () => {
    for (const [look, tokens] of NEUTRAL_LOOKS) {
      for (const name of [
        "background",
        "foreground",
        "card",
        "primary",
        "primary-foreground",
        "muted",
        "muted-foreground",
        "border",
        "sidebar",
        "sidebar-primary",
        "sidebar-accent",
        "ring",
      ]) {
        const [, chroma] = parseOklch(tokens.get(name) ?? "").lch;
        expect(chroma, `${look}: --${name}`).toBeLessThan(0.02);
      }
    }
  });

  for (const [look, pins] of Object.entries(NEUTRAL_PINS)) {
    it(`${look} keeps its 0.1.0 values`, () => {
      const tokens = look === "Neutral light" ? neutralLight : neutralDark;
      for (const [name, expected] of Object.entries(pins)) {
        expect(toHex(token(tokens, name)), `${look}: --${name}`).toBe(expected);
      }
    });
  }

  it("keeps the status tones and the ring of information in Lapis", () => {
    expect(toHex(token(neutralLight, "info"))).toBe("#2B4C9B");
    expect(toHex(token(neutralDark, "info"))).toBe("#9DB4E6");
  });
});

describe("the mark's colours", () => {
  // The mark (logo) keeps the brand colours in every colour scheme: it has its
  // own tokens, which the Neutral blocks never set. White label overrides them.
  const MARK_TOKENS = ["mark-hold", "mark-beam"] as const;
  const hex = (tokens: Tokens, name: string) => toHex(token(tokens, name));

  it("are Nile and Lapis in light, Limestone and Lapis Dark in dark", () => {
    expect(hex(light, "mark-hold")).toBe("#0F1B2D");
    expect(hex(light, "mark-beam")).toBe("#2B4C9B");
    expect(hex(dark, "mark-hold")).toBe("#F4F5F7");
    expect(hex(dark, "mark-beam")).toBe("#9DB4E6");
  });

  it("are not overridden by the Neutral blocks", () => {
    for (const name of MARK_TOKENS) {
      expect(neutralLightOverrides.has(name), `${NEUTRAL_LIGHT_SELECTOR} sets --${name}`).toBe(
        false,
      );
      expect(neutralDarkOverrides.has(name), `${NEUTRAL_DARK_SELECTOR} sets --${name}`).toBe(false);
    }
    // Nor does any other block outside :root and .dark: the file defines each token there only.
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const name of MARK_TOKENS) {
      const defined = [...source.matchAll(new RegExp(`--${name}\\s*:`, "g"))].length;
      expect(defined, `--${name} is defined once for light and once for dark`).toBe(2);
    }
  });

  it("come out the same in all four looks", () => {
    for (const name of MARK_TOKENS) {
      expect(neutralLight.get(name), `Neutral light --${name}`).toBe(light.get(name));
      expect(neutralDark.get(name), `Neutral dark --${name}`).toBe(dark.get(name));
    }
  });

  it(`are visible as graphics (${CHART_CONTRAST_MIN}:1) on the page, cards and sidebar of every look`, () => {
    for (const [look, tokens] of LOOKS) {
      for (const name of MARK_TOKENS) {
        for (const surface of ["background", "card", "sidebar"] as const) {
          const ratio = contrast(token(tokens, name), token(tokens, surface));
          expect(ratio, `${look}: --${name} on --${surface}`).toBeGreaterThanOrEqual(
            CHART_CONTRAST_MIN,
          );
        }
      }
    }
  });

  it("are not the success green and are exposed as Tailwind colours for the mark", () => {
    for (const [look, tokens] of LOOKS) {
      for (const name of MARK_TOKENS) {
        expect(hex(tokens, name), `${look}: --${name}`).not.toBe("#2DA37A");
      }
    }
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).toMatch(/--color-mark-hold:\s*var\(--mark-hold\)/);
    expect(source).toMatch(/--color-mark-beam:\s*var\(--mark-beam\)/);
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
