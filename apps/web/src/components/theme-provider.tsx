import * as React from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export const THEME_STORAGE_KEY = "restow.theme";

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

// Runs once when this module is first imported, which happens before
// main.tsx calls createRoot().render(): React's first render already has the
// right theme instead of rendering light and switching in an effect afterwards.
// The page may paint once before the (deferred) bundle runs; index.css covers
// that paint with the system preference.
applyTheme(resolveTheme(readStoredTheme()));

/**
 * Light/dark/system theme for the app. The choice is persisted per browser,
 * `system` follows the OS preference live, and a change in another tab is
 * picked up through the storage event.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(readStoredTheme);
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
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // Layout effect: later changes land before the browser paints.
  React.useLayoutEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = React.useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage access failures; the choice then lasts for this page only.
    }
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
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
