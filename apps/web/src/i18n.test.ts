// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyDemoLanguage, chooseLanguage, i18n } from "@/i18n";

const CHOSEN_KEY = "restow.language.chosen";

/** In-memory Storage: Node 25's own global localStorage needs a backing file. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, String(value));
    },
  };
}

describe("demo language", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    localStorage.removeItem(CHOSEN_KEY);
    // A German browser: detection picked German, nobody chose anything.
    await i18n.changeLanguage("de");
  });

  afterEach(async () => {
    localStorage.removeItem(CHOSEN_KEY);
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  });

  it("starts the public demo in English when the visitor has not picked a language", async () => {
    applyDemoLanguage(true);
    await vi.waitFor(() => expect(i18n.resolvedLanguage).toBe("en"));
    expect(document.documentElement.lang).toBe("en");
  });

  it("keeps the language a demo visitor picked themselves", async () => {
    await chooseLanguage("de");
    expect(localStorage.getItem(CHOSEN_KEY)).toBe("1");
    applyDemoLanguage(true);
    await Promise.resolve();
    expect(i18n.resolvedLanguage).toBe("de");
  });

  it("leaves a regular installation on the detected language", async () => {
    applyDemoLanguage(false);
    await Promise.resolve();
    expect(i18n.resolvedLanguage).toBe("de");
  });
});
