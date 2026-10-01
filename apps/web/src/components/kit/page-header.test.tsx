import { Database, HardDrive } from "lucide-react";
import { beforeAll, describe, expect, it } from "vitest";

import { PageHeader } from "@/components/page-header";
import { i18n } from "@/i18n";

import { PageProvider, documentTitle, usePageFrame, usePageTitle } from "./page-context.js";
import { count, render } from "./test-utils.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function PageTitleProbe() {
  return <output>{usePageTitle() ?? "none"}</output>;
}

function TenantProbe() {
  return <output>{usePageFrame().tenantName ?? "none"}</output>;
}

describe("PageHeader", () => {
  it("keeps the old API: title, description and children as actions", () => {
    const html = render(
      <PageHeader title="Storage" description="Where snapshots live.">
        <button type="button">Add target</button>
      </PageHeader>,
    );
    expect(html).toMatch(/<h1[^>]*>Storage<\/h1>/);
    expect(html).toContain("Where snapshots live.");
    expect(html).toContain("Add target");
    expect(count(html, "<svg")).toBe(0);
  });

  it("falls back to the icon of the active nav item", () => {
    const html = render(
      <PageProvider icon={HardDrive} tenantName="Example Ltd">
        <PageHeader title="Storage" />
      </PageProvider>,
    );
    expect(html).toContain("lucide-hard-drive");
  });

  it("prefers its own icon and can show none", () => {
    const own = render(
      <PageProvider icon={HardDrive}>
        <PageHeader title="Storage" icon={Database} />
      </PageProvider>,
    );
    expect(own).toContain("lucide-database");
    expect(own).not.toContain("lucide-hard-drive");

    const none = render(
      <PageProvider icon={HardDrive}>
        <PageHeader title="Storage" icon={null} />
      </PageProvider>,
    );
    expect(count(none, "<svg")).toBe(0);
  });

  it("renders the actions slot before children and a script-focusable h1", () => {
    const html = render(
      <PageHeader title="Jobs" actions={<button type="button">Refresh</button>}>
        <button type="button">New job</button>
      </PageHeader>,
    );
    expect(html.indexOf("Refresh")).toBeLessThan(html.indexOf("New job"));
    expect(html).toMatch(/<h1 tabindex="-1"/i);
  });

  it("accepts rich descriptions", () => {
    const html = render(<PageHeader title="Jobs" description={<span>Tenant: Example</span>} />);
    expect(html).toContain('<div class="max-w-prose text-sm text-muted-foreground"><span>');
  });
});

describe("page context", () => {
  it("has safe defaults outside the shell", () => {
    expect(render(<PageTitleProbe />)).toContain(">none<");
    expect(render(<TenantProbe />)).toContain(">none<");
  });

  it("carries the tenant name from the shell", () => {
    const html = render(
      <PageProvider tenantName="Example Ltd">
        <TenantProbe />
      </PageProvider>,
    );
    expect(html).toContain(">Example Ltd<");
  });

  it("builds the document title from page, tenant and product", () => {
    expect(documentTitle("Storage", "Example Ltd", "Restow")).toBe(
      "Storage · Example Ltd · Restow",
    );
    expect(documentTitle("Storage", null, "Restow")).toBe("Storage · Restow");
    expect(documentTitle("  ", "  ", "Restow")).toBe("Restow");
  });
});
