import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The theme module (components/theme-provider.tsx) must put the right class
 * and the colour scheme (`data-palette`) on <html> as soon as it is imported,
 * i.e. before main.tsx renders anything, so the first paint never flashes the
 * wrong theme. These tests import the module fresh against stubbed browser
 * globals and render nothing.
 */

interface Environment {
  /** The stored mode (`restow.theme`). */
  stored?: string | null;
  /** The stored colour scheme (`restow.palette`). */
  storedPalette?: string | null;
  storageThrows?: boolean;
  systemDark?: boolean;
}

function stubBrowser({
  stored = null,
  storedPalette = null,
  storageThrows = false,
  systemDark = false,
}: Environment) {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  vi.stubGlobal("document", {
    documentElement: {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name) ?? null,
      classList: {
        toggle: (name: string, force?: boolean) => {
          const on = force ?? !classes.has(name);
          if (on) {
            classes.add(name);
          } else {
            classes.delete(name);
          }
          return on;
        },
        contains: (name: string) => classes.has(name),
      },
    },
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (storageThrows) {
        throw new Error("SecurityError: storage is disabled");
      }
      return key === "restow.palette" ? storedPalette : stored;
    },
    setItem: () => undefined,
  });
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" && systemDark,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  return { classes, attributes };
}

async function importThemeModule() {
  vi.resetModules();
  return import("@/components/theme-provider");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme bootstrap", () => {
  it("applies a stored dark theme on import, before any render", async () => {
    const { classes } = stubBrowser({ stored: "dark", systemDark: false });
    await importThemeModule();
    expect([...classes]).toEqual(["dark"]);
  });

  it("applies a stored light theme even when the system is dark", async () => {
    // `.light` is explicit so index.css can tell it apart from the unclassed
    // page before this module runs, which follows the (dark) system instead.
    const { classes } = stubBrowser({ stored: "light", systemDark: true });
    await importThemeModule();
    expect([...classes]).toEqual(["light"]);
  });

  it("switches between the two classes without leaving the other behind", async () => {
    const { classes } = stubBrowser({ stored: "dark" });
    const { applyTheme } = await importThemeModule();
    applyTheme("light");
    expect([...classes]).toEqual(["light"]);
    applyTheme("dark");
    expect([...classes]).toEqual(["dark"]);
  });

  it("follows the system preference for 'system' or no stored choice", async () => {
    const { classes: explicit } = stubBrowser({ stored: "system", systemDark: true });
    await importThemeModule();
    expect(explicit.has("dark")).toBe(true);

    const { classes: unset } = stubBrowser({ stored: null, systemDark: true });
    await importThemeModule();
    expect(unset.has("dark")).toBe(true);

    const { classes: lightSystem } = stubBrowser({ stored: null, systemDark: false });
    await importThemeModule();
    expect([...lightSystem]).toEqual(["light"]);
  });

  it("falls back to the system preference for unknown stored values and blocked storage", async () => {
    // A dark system proves the fallback: passing "sepia" through unvalidated
    // would resolve to "not dark" and leave the class off.
    const { classes: unknown } = stubBrowser({ stored: "sepia", systemDark: true });
    const { readStoredTheme } = await importThemeModule();
    expect(unknown.has("dark")).toBe(true);
    expect(readStoredTheme()).toBe("system");

    const { classes: blocked } = stubBrowser({ storageThrows: true, systemDark: true });
    await importThemeModule();
    expect(blocked.has("dark")).toBe(true);
  });

  it("resolves themes without touching the DOM", async () => {
    stubBrowser({});
    const { resolveTheme } = await importThemeModule();
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });

  it("applies a stored colour scheme on import, next to the mode and independently of it", async () => {
    const neutral = stubBrowser({ stored: "dark", storedPalette: "neutral" });
    await importThemeModule();
    expect([...neutral.classes]).toEqual(["dark"]);
    expect(neutral.attributes.get("data-palette")).toBe("neutral");

    const neutralLight = stubBrowser({
      stored: "light",
      storedPalette: "neutral",
      systemDark: true,
    });
    await importThemeModule();
    expect([...neutralLight.classes]).toEqual(["light"]);
    expect(neutralLight.attributes.get("data-palette")).toBe("neutral");

    const brand = stubBrowser({ stored: "dark", storedPalette: "restow" });
    await importThemeModule();
    expect(brand.attributes.get("data-palette")).toBe("restow");
  });

  it("defaults to the Restow scheme for no stored choice, an unknown value or blocked storage", async () => {
    const unset = stubBrowser({});
    await importThemeModule();
    expect(unset.attributes.get("data-palette")).toBe("restow");

    const unknown = stubBrowser({ storedPalette: "sepia" });
    const { readStoredPalette } = await importThemeModule();
    expect(unknown.attributes.get("data-palette")).toBe("restow");
    expect(readStoredPalette()).toBe("restow");

    const blocked = stubBrowser({ storageThrows: true, systemDark: true });
    await importThemeModule();
    expect(blocked.attributes.get("data-palette")).toBe("restow");
    expect(blocked.classes.has("dark")).toBe(true);
  });

  it("switches the colour scheme without touching the mode classes", async () => {
    const { classes, attributes } = stubBrowser({ stored: "dark" });
    const { applyPalette } = await importThemeModule();
    applyPalette("neutral");
    expect(attributes.get("data-palette")).toBe("neutral");
    expect([...classes]).toEqual(["dark"]);
    applyPalette("restow");
    expect(attributes.get("data-palette")).toBe("restow");
    expect([...classes]).toEqual(["dark"]);
  });

  it("stores the scheme under its own key, apart from the mode", async () => {
    stubBrowser({});
    const { PALETTE_STORAGE_KEY, THEME_STORAGE_KEY } = await importThemeModule();
    expect(PALETTE_STORAGE_KEY).toBe("restow.palette");
    expect(THEME_STORAGE_KEY).toBe("restow.theme");
  });
});
