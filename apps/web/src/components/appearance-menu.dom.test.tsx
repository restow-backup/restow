// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceMenuItems } from "@/components/appearance-menu";
import { PALETTE_STORAGE_KEY, ThemeProvider } from "@/components/theme-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { i18n } from "@/i18n";

/**
 * The two appearance choices of the user menu and the sign-in pages: the
 * colour scheme (the product's own or Neutral) and the mode, as separate radio
 * groups; choosing a scheme changes <html> and is remembered, and leaves the
 * mode alone.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let store: Map<string, string>;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => store.get(name) ?? null,
    setItem: (name: string, value: string) => void store.set(name, value),
    removeItem: (name: string) => void store.delete(name),
  });
  document.documentElement.removeAttribute("data-palette");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <DropdownMenu open modal={false}>
            <DropdownMenuTrigger>Appearance</DropdownMenuTrigger>
            <DropdownMenuContent>
              <AppearanceMenuItems />
            </DropdownMenuContent>
          </DropdownMenu>
        </ThemeProvider>
      </I18nextProvider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const radios = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
const radio = (name: string) => radios().find((item) => item.textContent === name);

describe("AppearanceMenuItems", () => {
  it("offers the colour scheme and the mode as two groups", () => {
    const groups = [...document.querySelectorAll('[role="group"]')].map((group) =>
      group.getAttribute("aria-label"),
    );
    expect(groups).toEqual(["Colour scheme", "Mode"]);
    expect(radios().map((item) => item.textContent)).toEqual([
      "Restow",
      "Neutral",
      "Light",
      "Dark",
      "System",
    ]);
    expect(document.body.textContent).toContain("Applies to this browser only.");
  });

  it("marks the current scheme and mode", () => {
    expect(radio("Restow")?.getAttribute("aria-checked")).toBe("true");
    expect(radio("Neutral")?.getAttribute("aria-checked")).toBe("false");
    expect(radio("System")?.getAttribute("aria-checked")).toBe("true");
  });

  it("applies and remembers the chosen scheme without changing the mode", () => {
    act(() => radio("Neutral")?.click());
    expect(document.documentElement.getAttribute("data-palette")).toBe("neutral");
    expect(store.get(PALETTE_STORAGE_KEY)).toBe("neutral");
    expect(radio("Neutral")?.getAttribute("aria-checked")).toBe("true");
    expect(radio("System")?.getAttribute("aria-checked")).toBe("true");
  });
});
