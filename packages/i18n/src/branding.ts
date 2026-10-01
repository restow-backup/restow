import type { i18n } from "i18next";

/**
 * The product name users see (branding, the basis of White Label).
 *
 * No translation, template or renderer names the product itself. Texts carry
 * the `{appName}` placeholder, and this module is the one place the name comes
 * from: the default below, or the operator's `RESTOW_PRODUCT_NAME`.
 *
 * - Server processes call {@link configureProductName} once with the configured
 *   name; every `createI18n()` after that resolves `{appName}` to it.
 * - The web app asks the API for the name (public setup state) and applies it
 *   to its one i18next instance with {@link applyProductNameToInstance}.
 *
 * Technical identifiers are not branding and keep their names: binary names,
 * `RESTOW_*` variables, `X-Restow-*` headers, key prefixes, problem types and
 * format identifiers.
 */

/** The name of the product until an operator brands it differently. */
export const DEFAULT_PRODUCT_NAME = "Restow";

/** The environment variable that overrides {@link DEFAULT_PRODUCT_NAME}. */
export const PRODUCT_NAME_ENV = "RESTOW_PRODUCT_NAME";

/** Longest product name kept; it has to fit headings, mail subjects and PDF headers. */
export const MAX_PRODUCT_NAME_LENGTH = 60;

/**
 * A product name that is safe to place in any text: control and invisible
 * formatting characters (line breaks, bidi overrides) are dropped, runs of
 * whitespace collapse, the result is trimmed and cut to
 * {@link MAX_PRODUCT_NAME_LENGTH} characters. Nothing usable left (or nothing
 * given) means the default.
 */
export function normalizeProductName(value: string | null | undefined): string {
  const cleaned = (value ?? "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const name = Array.from(cleaned).slice(0, MAX_PRODUCT_NAME_LENGTH).join("").trim();
  return name.length > 0 ? name : DEFAULT_PRODUCT_NAME;
}

let configured = DEFAULT_PRODUCT_NAME;

/**
 * Set the product name of this process (server side). `null` or `undefined`
 * restores the default. Returns the normalized name now in effect.
 */
export function configureProductName(value: string | null | undefined): string {
  configured = normalizeProductName(value);
  return configured;
}

/** The product name of this process: what `{appName}` resolves to unless a call says otherwise. */
export function productName(): string {
  return configured;
}

/**
 * Make `{appName}` resolve to `value` on an existing i18next instance (the web
 * app's). Returns true when the name changed, so the caller can re-render.
 */
export function applyProductNameToInstance(
  instance: i18n,
  value: string | null | undefined,
): boolean {
  const name = normalizeProductName(value);
  const interpolation = instance.options.interpolation ?? {};
  if (interpolation.defaultVariables?.appName === name) {
    return false;
  }
  interpolation.defaultVariables = { ...interpolation.defaultVariables, appName: name };
  instance.options.interpolation = interpolation;
  return true;
}
