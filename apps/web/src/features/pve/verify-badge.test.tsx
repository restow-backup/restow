import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveRestorePoint } from "./api";
import { VerifyBadge } from "./guest-page";

/**
 * The restore check of a restore point on the guest page: a check another run's lock kept out
 * is postponed (the earlier result stands), then "could not check" (attention), never "failed".
 */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const render = (verify: PveRestorePoint["verify"], verifyRequested = false) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <VerifyBadge point={{ verify, verifyRequested } as PveRestorePoint} />
    </I18nextProvider>,
  );

const detail = "repository is already locked by PID 4711 on host pve1 by root";

describe("the restore check of a restore point", () => {
  it("says a check that could not run is not checked, with who held the lock", () => {
    const html = render({
      blocks: 0,
      mismatched: 0,
      errors: [],
      notChecked: { reason: "locked", detail, attempts: 12, gaveUpAt: "2026-10-21T05:00:00Z" },
    });
    expect(html).toContain("Could not check: repository locked");
    expect(html).toContain('data-variant="warning"');
    expect(html).toContain("PID 4711 on host pve1");
    expect(html).not.toContain("Failed");
    expect(html).not.toContain('data-variant="destructive"');
    expect(html).not.toContain('data-variant="success"');
  });

  it("says a new check is queued above the earlier result", () => {
    const failed = {
      checkedAt: "2026-10-21T21:43:00Z",
      blocks: 0,
      mismatched: 0,
      errors: ["exit 11"],
    };
    const asked = render(failed, true);
    expect(asked).toContain('data-slot="pve-point-verify-requeued"');
    expect(asked).toContain("Failed");
    expect(render(failed)).not.toContain("pve-point-verify-requeued");
  });

  it("keeps the earlier result while the check is postponed, and says why it waits", () => {
    const passed = render(
      {
        checkedAt: "2026-10-14T05:00:00Z",
        blocks: 0,
        mismatched: 0,
        errors: [],
        notChecked: { reason: "locked", detail, attempts: 1 },
      },
      true,
    );
    expect(passed).toContain("Passed");
    expect(passed).toContain("Check postponed: repository locked");
    const first = render({
      blocks: 0,
      mismatched: 0,
      errors: [],
      notChecked: { reason: "interrupted", detail: "", attempts: 1 },
    });
    expect(first).toContain("Check postponed: check interrupted");
    expect(first).not.toContain("Passed");
  });
});
