// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PALETTE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
} from "@/components/theme-provider";

/**
 * The provider's colour scheme: chosen next to the mode, kept under its own
 * key, put on <html> as `data-palette`, followed across tabs, and harmless
 * when the browser blocks storage.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let current: ReturnType<typeof useTheme>;

function Probe() {
  current = useTheme();
  return null;
}

function mount(): void {
  act(() =>
    root.render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    ),
  );
}

const html = () => document.documentElement;

/** An in-memory storage (happy-dom's is not usable under Node's own); `blockWrites` is a browser that refuses to store. */
function stubStorage(initial: Record<string, string> = {}, blockWrites = false) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => store.get(name) ?? null,
    setItem: (name: string, value: string) => {
      if (blockWrites) {
        throw new Error("QuotaExceededError");
      }
      store.set(name, value);
    },
    removeItem: (name: string) => void store.delete(name),
  });
  return store;
}

beforeEach(() => {
  html().removeAttribute("data-palette");
  html().className = "";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ThemeProvider colour scheme", () => {
  it("starts with the brand scheme and puts it on <html>", () => {
    stubStorage();
    mount();
    expect(current.palette).toBe("restow");
    expect(html().getAttribute("data-palette")).toBe("restow");
  });

  it("starts with the stored scheme", () => {
    stubStorage({ [PALETTE_STORAGE_KEY]: "neutral" });
    mount();
    expect(current.palette).toBe("neutral");
    expect(html().getAttribute("data-palette")).toBe("neutral");
  });

  it("changes the scheme, stores it under its own key and leaves the mode alone", () => {
    const store = stubStorage({ [THEME_STORAGE_KEY]: "dark" });
    mount();
    expect(html().classList.contains("dark")).toBe(true);
    act(() => current.setPalette("neutral"));
    expect(current.palette).toBe("neutral");
    expect(html().getAttribute("data-palette")).toBe("neutral");
    expect(store.get(PALETTE_STORAGE_KEY)).toBe("neutral");
    expect(store.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(current.theme).toBe("dark");
    expect(html().classList.contains("dark")).toBe(true);
  });

  it("changes the mode without touching the scheme", () => {
    const store = stubStorage({ [PALETTE_STORAGE_KEY]: "neutral" });
    mount();
    act(() => current.setTheme("light"));
    expect(html().classList.contains("light")).toBe(true);
    expect(html().getAttribute("data-palette")).toBe("neutral");
    expect(store.get(PALETTE_STORAGE_KEY)).toBe("neutral");
  });

  it("follows a change made in another tab, for the scheme only", () => {
    const store = stubStorage();
    mount();
    store.set(PALETTE_STORAGE_KEY, "neutral");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: PALETTE_STORAGE_KEY }));
    });
    expect(current.palette).toBe("neutral");
    expect(html().getAttribute("data-palette")).toBe("neutral");
    expect(current.theme).toBe("system");
  });

  it("keeps working for this page when the browser blocks storage", () => {
    stubStorage({}, true);
    mount();
    act(() => current.setPalette("neutral"));
    expect(current.palette).toBe("neutral");
    expect(html().getAttribute("data-palette")).toBe("neutral");
  });
});
