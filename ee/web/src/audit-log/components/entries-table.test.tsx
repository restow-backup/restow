import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import type { AuditEntry } from "../api";
import { useAuditFormat } from "../hooks";
import "../i18n";
import { AuditEntriesTable, TargetName } from "./entries-table";

/**
 * The target column of the audit log: the name of what an entry points at when
 * the server could resolve one (an import shows its mailbox, an upload its
 * file), the stored id as its tooltip, and an unresolved id whole in the small
 * monospace face instead of cut off in the middle.
 */

const IMPORT = "5b0a77d2-0c9a-4e0f-8c64-1f2d3a4b5c6d";
const UPLOAD = "a4c19e6b-93d0-41d7-a8f2-7e60b1c2d3e4";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "e-1",
    tenantId: "t-1",
    tenantName: "Contoso",
    actor: "admin@contoso.example",
    actorUserId: "u-1",
    action: "import.requested",
    target: IMPORT,
    targetType: "mail_import",
    targetLabel: null,
    onBehalfOf: null,
    ip: "192.0.2.1",
    details: null,
    prevHash: null,
    chainHash: "a".repeat(64),
    hashValid: true,
    createdAt: "2026-09-29T09:00:00.000Z",
    ...over,
  };
}

function Table({ entries }: { entries: readonly AuditEntry[] }) {
  const format = useAuditFormat();
  return (
    <AuditEntriesTable
      entries={entries}
      showTenant={false}
      selectedId={undefined}
      format={format}
      onOpen={() => {}}
    />
  );
}

function render(entries: readonly AuditEntry[]): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Table entries={entries} />
    </I18nextProvider>,
  );
}

describe("TargetName", () => {
  it("shows the name with the id as its tooltip", () => {
    const html = renderToStaticMarkup(<TargetName target={IMPORT} label="Anna Example" />);
    expect(html).toContain("Anna Example");
    expect(html).toContain(`title="${IMPORT}"`);
    // The id is not on the screen as text, only in the tooltip.
    expect(html).not.toContain(`>${IMPORT}<`);
  });

  it("shows an id without a name whole, in monospace, with the id as its tooltip", () => {
    const html = renderToStaticMarkup(<TargetName target={UPLOAD} label={null} />);
    expect(html).toContain("<code");
    expect(html).toContain(`>${UPLOAD}<`);
    expect(html).toContain(`title="${UPLOAD}"`);
    // Wrapped, not clipped: no ellipsis in the middle of an id.
    expect(html).toMatch(/<code class="[^"]*break-all[^"]*"/);
    expect(html).not.toMatch(/<code class="[^"]*truncate/);
  });

  it("shows a readable target such as an address as plain text", () => {
    const html = renderToStaticMarkup(<TargetName target="anna@contoso.example" label={null} />);
    expect(html).not.toContain("<code");
    expect(html).toContain("anna@contoso.example");
  });
});

describe("AuditEntriesTable", () => {
  it("names an import row after its mailbox and an upload row after its file", () => {
    const html = render([
      entry({ targetLabel: "Anna Example" }),
      entry({
        id: "e-2",
        action: "import.upload.completed",
        target: UPLOAD,
        targetType: "import_upload",
        targetLabel: "anna-2019.mbox",
      }),
    ]);
    expect(html).toContain("Anna Example");
    expect(html).toContain("anna-2019.mbox");
    expect(html).toContain("Import");
    expect(html).toContain("Import upload");
    // The ids are kept as tooltips, not shown in the cells.
    expect(html).toContain(`title="${IMPORT}"`);
    expect(html).toContain(`title="${UPLOAD}"`);
    expect(html).not.toContain(`>${IMPORT}<`);
    expect(html).not.toContain(`>${UPLOAD}<`);
  });

  it("falls back to the whole id for an import the server could not name", () => {
    const html = render([entry()]);
    expect(html).toContain(`>${IMPORT}<`);
  });

  it("keeps the dash for an entry without a target", () => {
    const html = render([entry({ target: null, targetType: null })]);
    expect(html).not.toContain(IMPORT);
  });
});
