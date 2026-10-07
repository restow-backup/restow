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
    expect(html).toContain("Not checked yet");
    expect(html).toContain('tabindex="0"');
  });

  it("shows a passed check as a passed sample in the success tone, never as 'Verified'", () => {
    const html = render(
      <SnapshotVerificationBadge
        verification={{ state: "green", checkedAt: "2026-09-22T03:00:00.000Z", reportId: "r1" }}
      />,
    );
    expect(html).toContain('data-tone="success"');
    expect(html).toContain('data-verification="green"');
    // A restore check reads back a sample: the badge says so instead of a blanket "Verified".
    expect(html).toContain("Sample passed");
    expect(html).not.toContain("Verified");
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
    expect(html).toContain("Restore check of this restore point on ");
    expect(html).toContain("a sample of its items was read back");
    expect(html).toContain("2026");
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    const html = render(
      <SnapshotVerificationBadge
        verification={{ state: "unverified", checkedAt: null, reportId: null }}
      />,
    );
    expect(html).toContain("Noch nicht geprüft");
    await i18n.changeLanguage("en");
  });
});
