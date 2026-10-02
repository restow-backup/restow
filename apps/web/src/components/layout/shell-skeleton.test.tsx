import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { ShellSkeleton } from "@/components/layout/shell-skeleton";
import { i18n } from "@/i18n";

/**
 * The placeholder the shell shows while the profile loads has the shape of
 * the shell: the sidebar with the tenant switcher under the wordmark, the top
 * bar with the scope pill, and a page. Nothing may move when the shell
 * arrives.
 */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function render(): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ShellSkeleton />
    </I18nextProvider>,
  );
}

describe("ShellSkeleton", () => {
  it("reserves the tenant switcher's row (one fixed height, with the gear) between the wordmark and the sections", () => {
    const html = render();
    const sidebar =
      html.match(
        /<div class="hidden shrink-0[^"]*md:flex[^"]*">.*?<\/div><div class="flex min-w-0 flex-1 flex-col">/s,
      )?.[0] ?? "";
    expect(sidebar).not.toBe("");
    // The wordmark row, then the switcher row (48 px, bordered, the gear 36 px wide), then the sections.
    const wordmark = sidebar.indexOf("h-12 items-center gap-2 p-2");
    const switcher = sidebar.indexOf("h-12 flex-1 items-center gap-2 rounded-md border");
    const firstSection = sidebar.indexOf("mb-2 h-3 w-16");
    expect(wordmark).toBeGreaterThan(-1);
    expect(switcher).toBeGreaterThan(wordmark);
    expect(firstSection).toBeGreaterThan(switcher);
    expect(sidebar).toContain("h-12 w-9 shrink-0 rounded-md");
  });

  it("puts a scope pill, not a switcher, in the top bar", () => {
    const html = render();
    const topBar =
      html.match(
        /<div class="flex h-\(--topbar-height\)[^"]*">.*?<\/div><div class="[^"]*">/s,
      )?.[0] ?? "";
    expect(topBar).toContain("h-6 w-28 rounded-full");
    // The old switcher placeholder (a 36 px high box beside the search button) is gone.
    expect(topBar).not.toContain("h-9 w-24 sm:w-40");
  });

  it("announces itself as busy, once, for assistive technology", () => {
    const html = render();
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/<span class="sr-only">/g)).toHaveLength(1);
  });
});
