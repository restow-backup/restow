import { createI18n } from "@restow/i18n";
import type { ConsentCallbackKind } from "./service.js";

/**
 * The page a customer's Global Admin sees after granting (or declining)
 * admin consent. That admin usually has no account here, so instead of the
 * sign-in wall of the web app they get a small, self-contained page that says
 * what happened and that the window can be closed. Signed-in operators are
 * redirected into the app instead (see routes.ts).
 *
 * Texts come from the `sources` translation files, formatted like every other
 * text (so the product name is the branding's); the page loads nothing from
 * anywhere (strict CSP) and reveals nothing about the tenant.
 */

export type LandingLanguage = "de" | "en";

/** How the outcome is presented to someone outside the installation. */
export type LandingVariant = "granted" | "denied" | "unverified" | "rejected" | "invalid";

/** Content-Security-Policy for the landing page: inline styles, nothing else. */
export const LANDING_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Pick German or English from an Accept-Language header (quality values respected). */
export { preferredLanguage } from "../../lib/language.js";

export function landingVariant(kind: ConsentCallbackKind): LandingVariant {
  switch (kind) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    case "identity_not_verified":
      return "unverified";
    case "tenant_already_connected":
    case "tenant_mismatch":
      return "rejected";
    case "invalid_state":
    case "unknown_source":
      return "invalid";
  }
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

const ICONS: Record<LandingVariant, string> = {
  granted: '<path d="M20 6 9 17l-5-5"/>',
  denied: '<path d="M18 6 6 18M6 6l12 12"/>',
  unverified:
    '<path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z"/><path d="M12 8v4m0 4h.01"/>',
  rejected:
    '<path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  invalid: '<path d="M12 8v4m0 4h.01"/><circle cx="12" cy="12" r="10"/>',
};

const TONES: Record<LandingVariant, string> = {
  granted: "var(--success)",
  denied: "var(--destructive)",
  unverified: "var(--warning)",
  rejected: "var(--warning)",
  invalid: "var(--warning)",
};

/** Render the complete HTML document for an outcome. */
export function renderConsentLanding(kind: ConsentCallbackKind, language: LandingLanguage): string {
  const i18n = createI18n({ lng: language });
  const copy = (key: string) => String(i18n.t(`sources:consentLanding.${key}`));
  const variant = landingVariant(kind);
  const title = escapeHtml(copy(`${variant}.title`));
  const body = escapeHtml(copy(`${variant}.body`));
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · ${escapeHtml(copy("product"))}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#0f172a;--muted:#5b6474;--border:#e3e6eb;--success:#15803d;--destructive:#b91c1c;--warning:#b45309;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#12151c;--fg:#e8ebf1;--muted:#98a1b2;--border:#232836;--success:#4ade80;--destructive:#f87171;--warning:#fbbf24}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px 28px 24px;box-shadow:0 1px 2px rgb(0 0 0/.04)}
svg{width:28px;height:28px;stroke:${TONES[variant]};fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
h1{font-size:19px;line-height:1.3;margin:14px 0 8px;font-weight:600;letter-spacing:-.01em}
p{margin:0;color:var(--muted)}
footer{margin-top:22px;padding-top:14px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)}
</style>
</head>
<body>
<main>
<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[variant]}</svg>
<h1>${title}</h1>
<p>${body}</p>
<footer>${escapeHtml(copy("close"))}</footer>
</main>
</body>
</html>`;
}
