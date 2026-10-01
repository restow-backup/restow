import { type SupportedLanguage, fallbackLanguage, supportedLanguages } from "@restow/i18n";
import type { Context } from "hono";

/**
 * The language to answer a person in, for texts the server itself produces
 * (test mails, the consent landing page). The web app sends its UI language
 * as `Accept-Language`, so what the operator reads in the browser is what the
 * server writes; other clients get their browser's preference.
 */

/** Pick a supported language from an Accept-Language header (quality values respected). */
export function preferredLanguage(acceptLanguage: string | null | undefined): SupportedLanguage {
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const quality = params
        .map((param) => /^q=([0-9.]+)$/.exec(param.trim())?.[1])
        .find((value) => value !== undefined);
      return { tag: tag.toLowerCase(), q: quality === undefined ? 1 : Number(quality), index };
    })
    .filter((entry) => entry.tag.length > 0 && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranked) {
    const match = supportedLanguages.find(
      (language) => tag === language || tag.startsWith(`${language}-`),
    );
    if (match) {
      return match;
    }
  }
  return fallbackLanguage;
}

/** The requester's language (see {@link preferredLanguage}). */
export function requestLanguage(c: Context): SupportedLanguage {
  return preferredLanguage(c.req.header("accept-language"));
}
