import * as React from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/**
 * The colour scheme, independent of the mode (light, dark, system): `restow`
 * is the brand look (Limestone, Nile and Lapis), `neutral` the black-and-white
 * look of 0.1.0. Every combination of scheme and mode exists.
 */
export type Palette = "restow" | "neutral";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  palette: Palette;
  setPalette: (palette: Palette) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export const THEME_STORAGE_KEY = "restow.theme";
export const PALETTE_STORAGE_KEY = "restow.palette";

/** The colour schemes in the order the menus list them; the first is the default. */
export const PALETTES: readonly Palette[] = ["restow", "neutral"];
export const DEFAULT_PALETTE: Palette = "restow";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/** The theme stored for this browser, `system` when none (or storage is blocked). */
export function readStoredTheme(): Theme {
  try {
    const value = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    if (isTheme(value)) {
      return value;
    }
  } catch {
    // Ignore storage access failures (private mode, disabled site data).
  }
  return "system";
}

function isPalette(value: unknown): value is Palette {
  return value === "restow" || value === "neutral";
}

/** The colour scheme stored for this browser, `restow` when none (or storage is blocked). */
export function readStoredPalette(): Palette {
  try {
    const value = globalThis.localStorage?.getItem(PALETTE_STORAGE_KEY);
    if (isPalette(value)) {
      return value;
    }
  } catch {
    // Ignore storage access failures (private mode, disabled site data).
  }
  return DEFAULT_PALETTE;
}

/** The operating system's colour scheme, `light` where it cannot be read. */
export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(theme: Theme, system: ResolvedTheme = systemTheme()): ResolvedTheme {
  return theme === "system" ? system : theme;
}

/**
 * Put exactly one of `.light` and `.dark` on <html>; the CSS tokens and
 * `color-scheme` follow it. Carrying `.light` explicitly (rather than just
 * "no `.dark`") lets index.css tell a chosen light theme apart from the moment
 * before this module has run, which follows the system preference instead.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") {
    return;
  }
  const { classList } = document.documentElement;
  classList.toggle("dark", resolved === "dark");
  classList.toggle("light", resolved === "light");
}

/**
 * Put the colour scheme on <html> as `data-palette="restow|neutral"`; the
 * Neutral blocks of index.css are selected by it. The attribute is always
 * present, so a stylesheet can target either scheme (white label does).
 */
export function applyPalette(palette: Palette): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.setAttribute("data-palette", palette);
}

// Runs once when this module is first imported, which happens before
// main.tsx calls createRoot().render(): React's first render already has the
// right theme and colour scheme instead of rendering the defaults and
// switching in an effect afterwards. The page may paint once before the
// (deferred) bundle runs; index.css covers that paint with the system
// preference.
applyTheme(resolveTheme(readStoredTheme()));
applyPalette(readStoredPalette());

/**
 * Mode (light/dark/system) and colour scheme (Restow/Neutral) for the app.
 * Both choices are persisted per browser, independently of each other;
 * `system` follows the OS preference live, and a change in another tab is
 * picked up through the storage event.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(readStoredTheme);
  const [palette, setPaletteState] = React.useState<Palette>(readStoredPalette);
  const [system, setSystem] = React.useState<ResolvedTheme>(systemTheme);

  const resolvedTheme = resolveTheme(theme, system);

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia(DARK_QUERY);
    const handleChange = () => setSystem(media.matches ? "dark" : "light");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  React.useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) {
        setThemeState(readStoredTheme());
      } else if (event.key === PALETTE_STORAGE_KEY) {
        setPaletteState(readStoredPalette());
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // Layout effect: later changes land before the browser paints.
  React.useLayoutEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  React.useLayoutEffect(() => {
    applyPalette(palette);
  }, [palette]);

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage access failures; the choice then lasts for this page only.
    }
  }, []);

  const setPalette = React.useCallback((next: Palette) => {
    setPaletteState(next);
    try {
      localStorage.setItem(PALETTE_STORAGE_KEY, next);
    } catch {
      // Ignore storage access failures; the choice then lasts for this page only.
    }
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, palette, setPalette }),
    [theme, resolvedTheme, setTheme, palette, setPalette],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (context === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
