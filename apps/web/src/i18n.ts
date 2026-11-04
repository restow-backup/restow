import {
  createI18n,
  fallbackLanguage,
  type SupportedLanguage,
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

/** The browser's language (`navigator.language`) when the app has it, else undefined. */
export function browserLanguage(): SupportedLanguage | undefined {
  const browser =
    typeof navigator !== "undefined" ? navigator.language?.slice(0, 2).toLowerCase() : undefined;
  return isSupported(browser) ? browser : undefined;
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

  return browserLanguage();
}

export const i18n = createI18n({ lng: detectInitialLanguage() });

/**
 * The cookie that tells the edge which language the app shows, so its static page for
 * "Restow is temporarily unavailable" (Caddyfile, @app_down_page_de) speaks the same
 * language as the app, not the browser's. Not a secret and read by nothing else.
 */
export const LANGUAGE_COOKIE = "restow_lang";

function writeLanguageCookie(language: string): void {
  if (typeof document === "undefined" || !isSupported(language)) {
    return;
  }
  const secure =
    typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing in Firefox and older Safari; the value is a fixed language code
    document.cookie = `${LANGUAGE_COOKIE}=${language}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  } catch {
    // Ignore cookie failures (disabled cookies); the edge then follows the browser.
  }
}

/** Keep <html lang> in sync and persist the chosen language. */
function applyLanguageSideEffects(language: string): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
  writeLanguageCookie(language);
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

export function languageWasChosen(): boolean {
  try {
    return localStorage.getItem(LANGUAGE_CHOSEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** The language the app shows right now, when it is one of the supported ones. */
export function activeLanguage(): SupportedLanguage {
  const current = i18n.resolvedLanguage ?? i18n.language;
  return isSupported(current) ? current : fallbackLanguage;
}

/**
 * The language the setup wizard preselects: what the visitor chose before, else
 * the browser's language, else English. Not what happens to be stored: the stored
 * language is the browser's at the time of the first visit, which is not a choice.
 */
export function setupLanguageSuggestion(): SupportedLanguage {
  if (languageWasChosen()) {
    return activeLanguage();
  }
  return browserLanguage() ?? fallbackLanguage;
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
