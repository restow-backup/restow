import { FolderOpen, Pause } from "lucide-react";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { CopyButton } from "./copy-button.js";
import { EmptyState } from "./empty-state.js";
import { IconButton } from "./icon-button.js";
import { RefreshButton } from "./refresh-button.js";
import { StatusBadge, type StatusTone } from "./status-badge.js";
import { count, render } from "./test-utils.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("StatusBadge", () => {
  it("maps every tone to its text-safe badge variant", () => {
    const expected: Record<StatusTone, string> = {
      success: "text-success-text",
      warning: "text-warning-text",
      destructive: "text-destructive-text",
      info: "text-info-text",
      muted: "text-muted-foreground",
      neutral: "text-foreground",
    };
    for (const [tone, token] of Object.entries(expected) as [StatusTone, string][]) {
      const html = render(<StatusBadge tone={tone}>Label</StatusBadge>);
      expect(html).toContain(token);
      expect(html).toContain(`data-tone="${tone}"`);
      expect(count(html, "<svg")).toBe(0);
    }
  });

  it("draws the neutral tone as an outline in the text colour, never green", () => {
    const html = render(<StatusBadge tone="neutral">Protected</StatusBadge>);
    expect(html).toContain('data-tone="neutral"');
    expect(html).toContain('data-variant="outline"');
    expect(html).toContain("border-border");
    expect(html).not.toContain("success");
    // A neutral state carries a plain ring, not the check mark of a passed check.
    expect(
      render(
        <StatusBadge tone="neutral" icon>
          Protected
        </StatusBadge>,
      ),
    ).toContain("lucide-circle");
    expect(
      render(
        <StatusBadge tone="neutral" icon>
          Protected
        </StatusBadge>,
      ),
    ).not.toContain("lucide-circle-check");
  });

  it("shows the tone's icon, a custom icon or a live pulse", () => {
    expect(
      render(
        <StatusBadge tone="success" icon>
          Verified
        </StatusBadge>,
      ),
    ).toContain("lucide-circle-check");
    expect(
      render(
        <StatusBadge tone="muted" icon={Pause}>
          Paused
        </StatusBadge>,
      ),
    ).toContain("lucide-pause");
    const live = render(
      <StatusBadge tone="info" icon live>
        Running
      </StatusBadge>,
    );
    expect(live).toContain("motion-safe:animate-ping");
    expect(live).toContain("bg-info");
    expect(count(live, "<svg")).toBe(0);
  });
});

describe("EmptyState", () => {
  it("shows icon, title, one sentence and the way forward", () => {
    const html = render(
      <EmptyState
        icon={FolderOpen}
        title="No sources yet"
        description="Connect a Microsoft 365 tenant or an IMAP server to start."
        actions={<button type="button">Add source</button>}
      />,
    );
    expect(html).toContain("lucide-folder-open");
    expect(html).toContain("No sources yet");
    expect(html).toContain("Connect a Microsoft 365 tenant");
    expect(html).toContain("Add source");
    expect(html).toContain("border-dashed");
  });

  it("accepts children as actions and a plain variant for tables", () => {
    const html = render(
      <EmptyState icon={FolderOpen} title="Nothing" variant="plain">
        <button type="button">Go</button>
      </EmptyState>,
    );
    expect(html).toContain(">Go<");
    expect(html).not.toContain("border-dashed");
  });
});

describe("icon buttons", () => {
  it("always name an icon-only button", () => {
    const html = render(<IconButton icon={Pause} label="Pause schedule" />);
    expect(html).toContain('aria-label="Pause schedule"');
    expect(html).toContain('data-variant="ghost"');
  });

  it("names the copy button and announces nothing before a copy", () => {
    expect(render(<CopyButton value="abc" />)).toContain('aria-label="Copy"');
    const html = render(<CopyButton value="abc" label="Copy redirect URI" />);
    expect(html).toContain('aria-label="Copy redirect URI"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("lucide-copy");
  });

  it("spins the refresh icon only while fetching", () => {
    const idle = render(<RefreshButton onRefresh={() => {}} />);
    expect(idle).toContain('aria-label="Refresh"');
    expect(idle).not.toContain("animate-spin");
    expect(idle).not.toContain("aria-busy");

    const busy = render(<RefreshButton onRefresh={() => {}} fetching />);
    expect(busy).toContain("animate-spin");
    expect(busy).toContain('aria-busy="true"');
    // Still focusable: a disabled button would drop keyboard focus mid-fetch.
    expect(busy).not.toContain('disabled=""');
  });
});
