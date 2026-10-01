import { readFileSync } from "node:fs";

import uiDe from "@restow/i18n/resources/de/ui.json" with { type: "json" };
import uiEn from "@restow/i18n/resources/en/ui.json" with { type: "json" };
import { MODE_FRAMES, STATE_TO_MODE, resolvePreset } from "thinking-orbs";
import { paintFrame } from "thinking-orbs/engine";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { ACTIVITY_ORB_STATE, type ActivityKind, ActivityOrb } from "./activity-orb.js";
import { render } from "./test-utils.js";

const KINDS = Object.keys(ACTIVITY_ORB_STATE) as ActivityKind[];

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("ACTIVITY_ORB_STATE mapping", () => {
  it("maps every activity to the state the brief asked for", () => {
    expect(ACTIVITY_ORB_STATE).toEqual({
      backupRunning: "working",
      restoreRunning: "weaving",
      verifying: "solving",
      restoreTest: "solving",
      directorySync: "connecting",
      sourceConsent: "connecting",
      searching: "searching",
      exporting: "composing",
      reportGenerating: "composing",
      queued: "breathing",
      throttled: "breathing",
      waitingFirstBackup: "breathing",
      scrubbing: "shaping",
      integrityCheck: "shaping",
      storageMigration: "shaping",
    });
  });

  it("leaves 'listening' unused", () => {
    const usedStates = new Set(Object.values(ACTIVITY_ORB_STATE));
    expect(usedStates.has("listening")).toBe(false);
  });

  it("never names a finished result: no kind reads as succeeded, failed or completed", () => {
    const finishedWording = /succeeded|failed|completed|finished|done/i;
    for (const kind of KINDS) {
      expect(kind, `${kind} reads like a finished status; use StatusBadge instead`).not.toMatch(
        finishedWording,
      );
    }
  });

  it("only uses states thinking-orbs actually implements", () => {
    for (const kind of KINDS) {
      expect(Object.keys(STATE_TO_MODE)).toContain(ACTIVITY_ORB_STATE[kind]);
    }
  });

  it("resolves to a real, non-degenerate preset at both kit sizes", () => {
    for (const kind of KINDS) {
      for (const size of [20, 64] as const) {
        const resolved = resolvePreset(ACTIVITY_ORB_STATE[kind], size);
        expect(Object.keys(MODE_FRAMES)).toContain(resolved.mode);
        expect(resolved.speed).toBeGreaterThan(0);
        expect(resolved.opts).toBeTruthy();
      }
    }
  });
});

describe("activityOrb i18n", () => {
  it("has an aria-label for every activity, identical keys in de and en", () => {
    for (const kind of KINDS) {
      expect(typeof uiEn.activityOrb[kind]).toBe("string");
      expect(uiEn.activityOrb[kind].length).toBeGreaterThan(0);
      expect(typeof uiDe.activityOrb[kind]).toBe("string");
      expect(uiDe.activityOrb[kind].length).toBeGreaterThan(0);
    }
    expect(Object.keys(uiEn.activityOrb).sort()).toEqual([...KINDS].sort());
    expect(Object.keys(uiDe.activityOrb).sort()).toEqual([...KINDS].sort());
  });

  it("gives each activity its own wording, not a shared placeholder", () => {
    const enLabels = KINDS.map((kind) => uiEn.activityOrb[kind]);
    expect(new Set(enLabels).size).toBe(KINDS.length);
    const deLabels = KINDS.map((kind) => uiDe.activityOrb[kind]);
    expect(new Set(deLabels).size).toBe(KINDS.length);
  });
});

describe("ActivityOrb", () => {
  it("renders as an accessible image with the activity's i18n label", () => {
    const html = render(<ActivityOrb kind="backupRunning" />);
    expect(html).toContain('role="img"');
    expect(html).toContain(`aria-label="${uiEn.activityOrb.backupRunning}"`);
    expect(html).toContain('data-activity="backupRunning"');
  });

  it("defaults to size 64 and accepts the inline size 20", () => {
    const detail = render(<ActivityOrb kind="restoreRunning" />);
    expect(detail).toMatch(/width:\s*64px/);
    expect(detail).toMatch(/height:\s*64px/);

    const inline = render(<ActivityOrb kind="restoreRunning" size={20} />);
    expect(inline).toMatch(/width:\s*20px/);
    expect(inline).toMatch(/height:\s*20px/);
  });

  it("lets a caller override the label when the surrounding text already names the activity", () => {
    const html = render(<ActivityOrb kind="scrubbing" label="Checking pack-004.osp" />);
    expect(html).toContain('aria-label="Checking pack-004.osp"');
    expect(html).not.toContain(uiEn.activityOrb.scrubbing);
  });

  it("carries a caller class alongside its own layout class", () => {
    const html = render(<ActivityOrb kind="queued" className="ml-2" />);
    expect(html).toMatch(/class="[^"]*shrink-0[^"]*ml-2[^"]*"/);
  });

  it("hides from assistive tech instead of announcing the activity twice when decorative", () => {
    // A caller places this next to text that already says "Running", so the
    // orb must not also claim role="img" or speak its own label.
    const html = render(<ActivityOrb kind="backupRunning" decorative />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain(uiEn.activityOrb.backupRunning);
  });

  it("keeps the accessible label and role by default (decorative is opt-in)", () => {
    const html = render(<ActivityOrb kind="backupRunning" />);
    expect(html).not.toContain("aria-hidden");
    expect(html).toContain('role="img"');
  });

  it("shows every activity kind with a translated label in German", async () => {
    await i18n.changeLanguage("de");
    try {
      for (const kind of KINDS) {
        const html = render(<ActivityOrb kind={kind} />);
        expect(html).toContain(`aria-label="${uiDe.activityOrb[kind]}"`);
      }
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("reduced motion and theme", () => {
  // thinking-orbs freezes on one tuned frame under `prefers-reduced-motion:
  // reduce` and reads dark/light from the ancestor `dark`/`light` class,
  // entirely inside its own effect (auto-detected, no override needed and
  // no browser DOM in this test to exercise it against). The only way
  // ActivityOrb could break either is by passing a prop that fights them, so
  // this locks the source down to the handful of props it is allowed to set.
  it("never overrides thinking-orbs' own dark/light or reduced-motion handling", () => {
    const source = readFileSync(new URL("./activity-orb.tsx", import.meta.url), "utf8");
    const [, jsx] = /<ThinkingOrb([\s\S]*?)\/>/.exec(source) ?? [];
    expect(jsx).toBeDefined();
    for (const allowed of ["state", "size", "aria-label", "className", "data-activity"]) {
      expect(jsx).toContain(`${allowed}=`);
    }
    for (const forbidden of [
      "paused",
      "theme",
      "speed",
      "dots",
      "dotSize",
      "frame",
      "gravity",
      "color",
    ]) {
      expect(jsx).not.toMatch(new RegExp(`[\\s{]${forbidden}\\s*=`));
    }
  });
});

describe("reduced-motion static frame is visible in light and dark", () => {
  // The prop-surface lock above only proves ActivityOrb does not fight
  // thinking-orbs' own reduced-motion and theme handling; it says nothing
  // about what that frozen frame actually looks like. `thinking-orbs/engine`
  // exposes the same pure functions the component calls under the hood
  // (`ThinkingOrb`'s own effect does exactly this: `paintFrame(ctx,
  // MODE_FRAMES[mode](size, 0.6, opts), dark)` when
  // `prefers-reduced-motion: reduce` is set), so this reruns that call
  // directly against a recording 2D-context stub and checks the result:
  // marks that actually paint, readable at >= 3:1 (WCAG 1.4.11, non-text
  // contrast) against the app's own surfaces in both themes.
  const REDUCED_MOTION_T = 0.6;
  const NON_TEXT_CONTRAST_MIN = 3;
  // Every activity kind maps to one of these states; sizes and themes are
  // exhaustive, so testing each state once (not each of the 15 kinds) covers
  // every combination ActivityOrb can actually render.
  const USED_STATES = [...new Set(Object.values(ACTIVITY_ORB_STATE))];
  const SIZES = [20, 64] as const;

  // -- colour maths, kept in sync by hand with
  // apps/web/src/components/ui/tokens.test.ts (this item does not own that
  // file, so the OKLCH/contrast helpers live here too rather than in a
  // shared module) --------------------------------------------------------

  type Rgb = readonly [number, number, number];
  type Tokens = ReadonlyMap<string, string>;

  const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

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

  function parseOklch(value: string): { lch: Rgb; alpha: number } {
    const match =
      /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(value);
    if (!match) {
      throw new Error(`not an oklch() colour: ${value}`);
    }
    const [, l, lPercent, c, h, a, aPercent] = match;
    const lightness = Number(l) / (lPercent ? 100 : 1);
    const alpha = a === undefined ? 1 : Number(a) / (aPercent ? 100 : 1);
    return { lch: [lightness, Number(c), Number(h)], alpha };
  }

  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const fromLinear = (c: number) =>
    c <= 0.0031308 ? 12.92 * c : 1.055 * clamp01(c) ** (1 / 2.4) - 0.055;

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

  function token(tokens: Tokens, name: string): Rgb {
    const value = tokens.get(name);
    if (value === undefined) {
      throw new Error(`token --${name} is not defined`);
    }
    const { lch, alpha } = parseOklch(value);
    expect(alpha, `--${name} must be opaque`).toBe(1);
    return oklchToSrgb(lch);
  }

  /** `rgba(...)` ink over an opaque surface: alpha compositing in gamma-encoded sRGB. */
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

  const light: Tokens = declarations(":root");
  const darkTokens: Tokens = new Map([...light, ...declarations(".dark")]);
  const THEMES = [
    { name: "light", tokens: light, dark: false },
    { name: "dark", tokens: darkTokens, dark: true },
  ] as const;
  const SURFACES = ["card", "background", "muted"] as const;

  // -- a 2D context stub that only records what thinking-orbs paints -------

  function recordingContext() {
    const marks: string[] = [];
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      beginPath() {},
      arc() {},
      moveTo() {},
      lineTo() {},
      fill() {
        marks.push(String(ctx.fillStyle));
      },
      stroke() {
        marks.push(String(ctx.strokeStyle));
      },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, marks };
  }

  /** thinking-orbs paints grayscale ink as `rgba(g,g,g,a)` (no tint is ever passed here). */
  function parseInk(style: string): { rgb: Rgb; alpha: number } {
    const match = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(style);
    if (!match) {
      throw new Error(`unexpected ink colour from thinking-orbs: ${style}`);
    }
    const [, r, g, b, a] = match;
    return { rgb: [Number(r) / 255, Number(g) / 255, Number(b) / 255], alpha: Number(a) };
  }

  for (const state of USED_STATES) {
    for (const size of SIZES) {
      it(`${state}@${size}: the frozen frame paints and stays readable in both themes`, () => {
        const resolved = resolvePreset(state, size);
        const frame = MODE_FRAMES[resolved.mode](size, REDUCED_MOTION_T, resolved.opts);
        expect(
          frame.dots.length + frame.lines.length,
          `${state}@${size} has no geometry to paint under reduced motion`,
        ).toBeGreaterThan(0);

        for (const theme of THEMES) {
          const { ctx, marks } = recordingContext();
          paintFrame(ctx, frame, theme.dark);
          expect(
            marks.length,
            `${state}@${size} painted nothing (dark=${theme.dark})`,
          ).toBeGreaterThan(0);

          const inks = marks.map(parseInk);
          for (const surface of SURFACES) {
            const surfaceRgb = token(theme.tokens, surface);
            const bestContrast = Math.max(
              ...inks.map(({ rgb, alpha }) =>
                contrast(composite(rgb, alpha, surfaceRgb), surfaceRgb),
              ),
            );
            expect(
              bestContrast,
              `${state}@${size} on ${theme.name} --${surface}`,
            ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MIN);
          }
        }
      });
    }
  }
});
