import {
  type SupportedLanguage,
  createI18n,
  fallbackLanguage,
  supportedLanguages,
} from "@restow/i18n";

/**
 * The web app's i18next instance, built from the shared @restow/i18n bundles
 * (every namespace, de and en). Every visible string resolves through `t()`;
 * nothing is hardcoded in components.
 */
const LANGUAGE_STORAGE_KEY = "restow.language";

function isSupported(value: string | null | undefined): value is SupportedLanguage {
  return value != null && (supportedLanguages as readonly string[]).includes(value);
}

/** Language preference: stored choice first, then the browser, then default. */
function detectInitialLanguage(): SupportedLanguage | undefined {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isSupported(stored)) {
      return stored;
    }
  } catch {
    // Ignore storage access failures (private mode, disabled cookies).
  }

  const browser = typeof navigator !== "undefined" ? navigator.language.slice(0, 2) : undefined;
  return isSupported(browser) ? browser : undefined;
}

export const i18n = createI18n({ lng: detectInitialLanguage() });

/** Keep <html lang> in sync and persist the chosen language. */
function applyLanguageSideEffects(language: string): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Ignore storage access failures.
  }
}

applyLanguageSideEffects(i18n.resolvedLanguage ?? i18n.language);
i18n.on("languageChanged", applyLanguageSideEffects);

/**
 * Set once the visitor picks a language themselves (language switcher, user
 * menu, command palette). The stored language alone cannot tell, because the
 * detected browser language is stored too.
 */
const LANGUAGE_CHOSEN_KEY = "restow.language.chosen";

/** Switch the language because the user picked it, and remember that they did. */
export function chooseLanguage(language: string): Promise<unknown> {
  try {
    localStorage.setItem(LANGUAGE_CHOSEN_KEY, "1");
  } catch {
    // Ignore storage access failures; the choice then lasts for this page load.
  }
  return i18n.changeLanguage(language);
}

function languageWasChosen(): boolean {
  try {
    return localStorage.getItem(LANGUAGE_CHOSEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The public demo starts in English whatever the browser prefers: a visitor
 * clicking through from the website should not have to find the language
 * switcher first. Once they pick a language themselves, that choice wins.
 */
export function applyDemoLanguage(demo: boolean): void {
  if (!demo || languageWasChosen()) {
    return;
  }
  if ((i18n.resolvedLanguage ?? i18n.language) !== fallbackLanguage) {
    void i18n.changeLanguage(fallbackLanguage);
  }
}
