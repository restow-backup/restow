import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The theme module (components/theme-provider.tsx) must put the right class
 * on <html> as soon as it is imported, i.e. before main.tsx renders anything,
 * so the first paint never flashes the wrong theme. These tests import the
 * module fresh against stubbed browser globals and render nothing.
 */

interface Environment {
  stored?: string | null;
  storageThrows?: boolean;
  systemDark?: boolean;
}

function stubBrowser({ stored = null, storageThrows = false, systemDark = false }: Environment) {
  const classes = new Set<string>();
  vi.stubGlobal("document", {
    documentElement: {
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
    getItem: () => {
      if (storageThrows) {
        throw new Error("SecurityError: storage is disabled");
      }
      return stored;
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
  return classes;
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
    const classes = stubBrowser({ stored: "dark", systemDark: false });
    await importThemeModule();
    expect([...classes]).toEqual(["dark"]);
  });

  it("applies a stored light theme even when the system is dark", async () => {
    // `.light` is explicit so index.css can tell it apart from the unclassed
    // page before this module runs, which follows the (dark) system instead.
    const classes = stubBrowser({ stored: "light", systemDark: true });
    await importThemeModule();
    expect([...classes]).toEqual(["light"]);
  });

  it("switches between the two classes without leaving the other behind", async () => {
    const classes = stubBrowser({ stored: "dark" });
    const { applyTheme } = await importThemeModule();
    applyTheme("light");
    expect([...classes]).toEqual(["light"]);
    applyTheme("dark");
    expect([...classes]).toEqual(["dark"]);
  });

  it("follows the system preference for 'system' or no stored choice", async () => {
    const explicit = stubBrowser({ stored: "system", systemDark: true });
    await importThemeModule();
    expect(explicit.has("dark")).toBe(true);

    const unset = stubBrowser({ stored: null, systemDark: true });
    await importThemeModule();
    expect(unset.has("dark")).toBe(true);

    const lightSystem = stubBrowser({ stored: null, systemDark: false });
    await importThemeModule();
    expect([...lightSystem]).toEqual(["light"]);
  });

  it("falls back to the system preference for unknown stored values and blocked storage", async () => {
    // A dark system proves the fallback: passing "sepia" through unvalidated
    // would resolve to "not dark" and leave the class off.
    const unknown = stubBrowser({ stored: "sepia", systemDark: true });
    const { readStoredTheme } = await importThemeModule();
    expect(unknown.has("dark")).toBe(true);
    expect(readStoredTheme()).toBe("system");

    const blocked = stubBrowser({ storageThrows: true, systemDark: true });
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
});
