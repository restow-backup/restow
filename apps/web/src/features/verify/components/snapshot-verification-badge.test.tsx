import { beforeAll, describe, expect, it } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import { SnapshotVerificationBadge } from "./snapshot-verification-badge";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("SnapshotVerificationBadge", () => {
  it("shows a backup no check has read back as 'Not verified yet' in the warning tone", () => {
    const html = render(
      <SnapshotVerificationBadge
        verification={{ state: "unverified", checkedAt: null, reportId: null }}
      />,
    );
    expect(html).toContain('data-tone="warning"');
    expect(html).not.toContain('data-tone="success"');
    expect(html).toContain("Not verified yet");
    expect(html).toContain('tabindex="0"');
  });

  it("shows a passed check as 'Verified' in the success tone", () => {
    const html = render(
      <SnapshotVerificationBadge
        verification={{ state: "green", checkedAt: "2026-09-22T03:00:00.000Z", reportId: "r1" }}
      />,
    );
    expect(html).toContain('data-tone="success"');
    expect(html).toContain('data-verification="green"');
    expect(html).toContain("Verified");
  });

  it("reads the hint with the label where the badge cannot take focus", () => {
    const html = render(
      <SnapshotVerificationBadge
        verification={{ state: "green", checkedAt: "2026-09-22T03:00:00.000Z", reportId: "r1" }}
        focusable={false}
      />,
    );
    expect(html).not.toContain("tabindex");
    expect(html).toContain('class="sr-only"');
    expect(html).toContain("Restore check of this backup: ");
    expect(html).toContain("2026");
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    const html = render(
      <SnapshotVerificationBadge
        verification={{ state: "unverified", checkedAt: null, reportId: null }}
      />,
    );
    expect(html).toContain("Noch nicht verifiziert");
    await i18n.changeLanguage("en");
  });
});
