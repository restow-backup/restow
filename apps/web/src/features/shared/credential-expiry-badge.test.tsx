import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { ExpiryBadge } from "./credential-expiry-badge";

/** The badge text and tone per stage, rendered to static markup. */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-23T10:00:00.000Z");
const inDays = (days: number) => new Date(NOW + days * DAY).toISOString();

function render(expiresAt: string | null, unknownText?: string): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ExpiryBadge expiresAt={expiresAt} now={NOW} unknownText={unknownText} />
    </I18nextProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("ExpiryBadge", () => {
  it("names the date while valid and the days left within the window", () => {
    expect(render("2027-03-01T00:00:00.000Z")).toContain("Valid until Mar 1, 2027");
    expect(render(inDays(30))).toContain("Expires in 30 days");
    expect(render(inDays(5))).toContain("Expires in 5 days");
    expect(render(inDays(-1))).toContain("Expired");
  });

  it("turns red from 7 days on, amber before", () => {
    const tones = (html: string) => html.match(/data-tone="([a-z]+)"/)?.[1];
    expect(tones(render(inDays(20)))).toBe("warning");
    expect(tones(render(inDays(7)))).toBe("destructive");
    expect(tones(render(inDays(-1)))).toBe("destructive");
    expect(tones(render(inDays(40)))).toBe("neutral");
  });

  it("reads unknown as a muted line, with the page's own hint where given", () => {
    expect(render(null)).not.toContain("data-tone");
    expect(render(null, "Not noted")).toContain("Not noted");
  });
});
