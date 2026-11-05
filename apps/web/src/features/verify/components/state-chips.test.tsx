import { beforeAll, describe, expect, it } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import { NO_STATES, StateChips } from "./state-chips";

/** A chip with nothing in it is dimmed and cannot be chosen, unless it is the current filter. */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function chip(html: string, state: string): string {
  const start = html.lastIndexOf("<button", html.indexOf(`data-state="${state}"`));
  return html.slice(start, html.indexOf("</button>", start));
}

describe("StateChips", () => {
  const counts = { ...NO_STATES, green: 1, yellow: 1, unverified: 18 };

  it("disables and dims the chips of empty categories", () => {
    const html = render(
      <StateChips counts={counts} total={20} value={undefined} onChange={() => {}} />,
    );
    for (const state of ["red", "no_backup"]) {
      expect(chip(html, state), state).toContain("disabled");
      expect(chip(html, state), state).toContain('data-empty="true"');
    }
    for (const state of ["green", "yellow", "unverified"]) {
      expect(chip(html, state), state).not.toContain("disabled");
    }
    // In the overview's order, each with its category's icon.
    const order = ["green", "yellow", "unverified", "red", "no_backup"].map((state) =>
      html.indexOf(`data-state="${state}"`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(chip(html, "yellow")).toContain('data-category="needs_attention"');
    expect(chip(html, "yellow")).toContain("Needs attention");
    expect(chip(html, "unverified")).toContain('data-category="unverified"');
  });

  it("keeps an empty chip clickable while it is the current filter, so it can be cleared", () => {
    const html = render(<StateChips counts={counts} total={20} value="red" onChange={() => {}} />);
    expect(chip(html, "red")).toContain('aria-pressed="true"');
    expect(chip(html, "red")).not.toContain("disabled");
    expect(chip(html, "no_backup")).toContain("disabled");
  });
});
