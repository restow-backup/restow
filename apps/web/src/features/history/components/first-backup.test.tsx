import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "../i18n";
import { run } from "../fixtures";
import { RunProgressCell } from "./run-cells";

/**
 * A first backup of a large mailbox runs for hours, over several attempts (#47): the row says
 * how far the whole first backup is, and gives a time left only as an estimate and only when
 * the source said how many items there are.
 */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const html = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

describe("a first backup in a row", () => {
  it("counts the whole first backup and words the time left as an estimate", () => {
    const out = html(
      <RunProgressCell
        run={run({ firstBackup: { itemsDone: 4_050, itemsTotal: 12_000, etaSeconds: 11_460 } })}
      />,
    );
    expect(out).toContain("First backup: 4,050 of 12,000 items");
    expect(out).toContain("about 3 h 15 min left (estimate)");
    // Not the attempt's own count and clock next to it.
    expect(out).not.toContain("400 of 1,000 items");
    expect(out).not.toContain("1:30 left");
  });

  it("gives no time left while the total is unknown", () => {
    const out = html(
      <RunProgressCell
        run={run({ firstBackup: { itemsDone: 500, itemsTotal: null, etaSeconds: null } })}
      />,
    );
    expect(out).toContain("First backup: 500 items so far");
    expect(out).not.toContain("left");
  });

  it("leaves every other run as it was", () => {
    const out = html(<RunProgressCell run={run({ firstBackup: null })} />);
    expect(out).toContain("400 of 1,000 items");
    expect(out).not.toContain("First backup");
  });
});
