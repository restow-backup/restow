import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveVmConsistency } from "./api";
import { PointConsistency } from "./guest-page";

/**
 * Whether PVE froze a VM's file systems for its restore point (restow-pve 0.5.0): a failed
 * freeze and an agent that did not answer are amber, a frozen guest is a plain fact, never
 * green, and an unrecorded point shows nothing.
 */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const render = (vmConsistency: PveVmConsistency | null | undefined, language = "en") => {
  void i18n.changeLanguage(language);
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <PointConsistency point={{ vmConsistency }} />
    </I18nextProvider>,
  );
};

describe("the consistency of a VM restore point", () => {
  it("shows a failed freeze in amber, with the node's error", () => {
    const html = render({
      state: "freeze_failed",
      detail: "guest-fsfreeze-freeze failed - got timeout",
    });
    expect(html).toContain("Freeze failed");
    expect(html).toContain('data-variant="warning"');
    expect(html).toContain("crash-consistent");
    expect(html).toContain("got timeout");
    expect(render({ state: "no_agent" })).toContain('data-variant="warning"');
  });

  it("states a frozen or crash-consistent point without green", () => {
    for (const state of ["frozen", "stopped", "crash_consistent", "unknown"] as const) {
      const html = render({ state });
      expect(html, state).toContain('data-slot="pve-point-consistency"');
      expect(html, state).not.toContain('data-variant="success"');
      expect(html, state).not.toContain('data-variant="warning"');
    }
    expect(render({ state: "frozen" })).toContain("File systems frozen");
  });

  it("shows nothing for a point without a record", () => {
    expect(render(null)).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("speaks German formally", () => {
    const html = render({ state: "no_agent" }, "de");
    expect(html).toContain("Gast-Agent antwortete nicht");
    expect(html).toContain("Prüfen Sie");
    void i18n.changeLanguage("en");
  });
});
