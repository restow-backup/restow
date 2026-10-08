import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "../i18n";

import { RoleField } from "./target-dialog";

/**
 * "keep" switches the primary right away and leaves the old target attached
 * read-only (docs/STORAGE.md, "Replace the primary"): once the worker can
 * read a "previous" target (apps/worker/src/handlers/framework.ts), the
 * dialog must offer it as a real, selectable choice, not a disabled one.
 * Rendered to static markup, so "selectable" is checked two ways: the radio
 * carries no `disabled` attribute, and it reflects whichever mode is
 * currently selected (a hardwired-disabled control would never do that).
 */

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

/** The `<button role="radio" .../>` for the given id, as Radix renders it. */
function radioTag(html: string, id: string): string {
  const marker = `id="${id}"`;
  const start = html.lastIndexOf("<button", html.indexOf(marker));
  const end = html.indexOf(">", html.indexOf(marker));
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, end + 1);
}

/** The `<label for="...">...</label>` for the given target id. */
function labelTag(html: string, forId: string): string {
  const marker = `for="${forId}"`;
  const start = html.lastIndexOf("<label", html.indexOf(marker));
  const end = html.indexOf("</label>", html.indexOf(marker));
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, end + "</label>".length);
}

describe("RoleField replace-primary radios", () => {
  it("offers 'keep' enabled, alongside 'move', once a primary is being replaced", () => {
    const html = render(
      <RoleField
        value="primary"
        onChange={() => {}}
        migrationMode="move"
        onMigrationModeChange={() => {}}
        primaryBlocked="primaryExists"
      />,
    );
    expect(html).toContain("Keep existing backups where they are");
    expect(html).toContain(
      "The new storage location becomes primary right away, nothing is copied. The old location stays in place, read-only: restoring, checking and backing up objects from before the switch keep working by reading it, but every new byte is written to the new storage location only.",
    );

    const keepTag = radioTag(html, "migration-mode-keep");
    // Not the boolean HTML attribute (Radix also sets `data-disabled` then);
    // the Tailwind `disabled:...` variant classes stay in `class` either way.
    expect(keepTag).not.toMatch(/(^|\s)disabled(=|\s|>)/);
    expect(keepTag).not.toContain("data-disabled");
    expect(keepTag).toContain('aria-checked="false"');

    const moveTag = radioTag(html, "migration-mode-move");
    expect(moveTag).toContain('aria-checked="true"');

    // Not styled as unusable: earlier this radio's label carried a hardcoded
    // `cursor-not-allowed`/`opacity-60` to match `disabled` (the base Label
    // component's own `peer-disabled:*` variant classes stay either way,
    // since they only apply when the radio itself is actually disabled).
    const keepLabel = labelTag(html, "migration-mode-keep");
    expect(keepLabel).toMatch(/(^|\s)cursor-pointer(\s|")/);
    // Not `peer-disabled:cursor-not-allowed` (the base Label's own variant,
    // present either way): the bare, always-on class this radio used to carry.
    expect(keepLabel).not.toMatch(/(^|\s)cursor-not-allowed(\s|")/);
    expect(keepLabel).not.toMatch(/(^|\s)opacity-60(\s|")/);
  });

  it("selects 'keep' when that is the current migration mode", () => {
    const html = render(
      <RoleField
        value="primary"
        onChange={() => {}}
        migrationMode="keep"
        onMigrationModeChange={() => {}}
        primaryBlocked="tenantHasData"
      />,
    );
    expect(radioTag(html, "migration-mode-keep")).toContain('aria-checked="true"');
    expect(radioTag(html, "migration-mode-move")).toContain('aria-checked="false"');
  });

  it("shows no migration-mode choice when the tenant has no primary to replace", () => {
    const html = render(
      <RoleField
        value="primary"
        onChange={() => {}}
        migrationMode="move"
        onMigrationModeChange={() => {}}
        primaryBlocked={null}
      />,
    );
    expect(html).not.toContain("migration-mode-keep");
  });
});
