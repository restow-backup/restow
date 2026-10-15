// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ShareRestorePoints } from "@/features/file-shares/components/share-restore-points";
import {
  iso,
  SHARE_ID,
  SNAPSHOT_ID,
  shareFixture,
  snapshotFixture,
} from "@/features/file-shares/fixtures";
import "@/features/file-shares/i18n";
import { type Rendered, render, slot, text } from "@/features/file-shares/testing";
import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import type { ObjectSuspicions, Suspicion } from "./api";

/**
 * The marks of the ransomware detection in a restore view (docs/RANSOMWARE.md), through the
 * file restore of a file share: the suspicious restore point is badged red, the hint above the
 * timeline names the last clean one and picks it, the reasons open with their numbers, and an
 * administrator marks a false alarm with a note.
 */

enableActEnvironment();

let rendered: Rendered | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await rendered?.mounted.unmount();
  rendered = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const BASE = `/file-shares/${SHARE_ID}`;
const CLEAN_ID = "5a1e0000-0000-4000-8000-0000000000c1";

function judgement(over: Partial<Suspicion> = {}): Suspicion {
  return {
    id: "6b000000-0000-4000-8000-000000000001",
    objectKind: "file_share",
    objectId: SHARE_ID,
    runId: "r1",
    restorePointId: SNAPSHOT_ID,
    restorePointAt: iso(-600),
    verdict: "suspicious",
    active: true,
    findings: [
      { code: "ransom_notes", value: 40, threshold: 2, examples: ["HOW_TO_DECRYPT.txt"] },
      { code: "mass_deletions", value: 3000, threshold: 1000, share: 0.6 },
    ],
    signals: { changeRate: "clear", deletions: "fired", names: "fired", entropy: "unavailable" },
    signaturesVersion: "2026.10-1",
    alerted: true,
    falseAlarm: null,
    judgedAt: iso(-590),
    ...over,
  };
}

function routes(list: Suspicion[], onFalseAlarm?: (body: unknown) => void) {
  const view: ObjectSuspicions = {
    objectKind: "file_share",
    objectId: SHARE_ID,
    open: list[0]?.active ?? false,
    openSince: list[0]?.active ? (list[0]?.restorePointAt ?? null) : null,
    lastClean: null,
    restorePoints: list,
  };
  return {
    [`GET ${BASE}/snapshots`]: () =>
      json({
        items: [
          snapshotFixture(),
          snapshotFixture({ id: CLEAN_ID, shortId: "c1ea0000", time: iso(-2000) }),
        ],
      }),
    [`GET ${BASE}/browse`]: () =>
      json({ snapshotId: CLEAN_ID, path: "/", entries: [], nextCursor: null, permissions: null }),
    [`GET ${BASE}/search`]: () => json({ items: [], truncated: false }),
    "GET /suspicions": () => json(view),
    [`POST /suspicions/${judgement().id}/false-alarm`]: async (request: { body?: unknown }) => {
      onFalseAlarm?.(request.body);
      return json({ ...judgement(), active: false });
    },
  };
}

describe("signs of ransomware in a restore view", () => {
  it("badges the suspicious restore point and leads to the last clean one", async () => {
    rendered = await render(
      <ShareRestorePoints share={shareFixture()} onShowRuns={() => undefined} />,
      {
        routes: routes([
          judgement(),
          judgement({
            id: "x",
            restorePointId: CLEAN_ID,
            verdict: "none",
            active: false,
            findings: [],
          }),
        ]),
      },
    );
    await flush(4);
    const hint = slot("last-clean-hint");
    expect(hint?.textContent).toContain("The newest restore point is suspicious");
    const [newest, older] = [...document.querySelectorAll('[data-slot="snapshot-list"] li')];
    expect(newest?.querySelector('[data-slot="suspicion-badge"]')?.textContent).toBe("Suspicious");
    expect(newest?.querySelector('[data-tone="destructive"]')).not.toBeNull();
    // No finding is no proof: a clean restore point gets no badge at all, never a green one.
    expect(older?.querySelector('[data-slot="suspicion-badge"]')).toBeNull();

    await click(buttonByText(hint as HTMLElement, "Use the last clean restore point"));
    await flush(3);
    expect(text()).toContain("c1ea0000");
  });

  it("explains the findings and records a false alarm with a note", async () => {
    let sent: unknown = null;
    rendered = await render(
      <ShareRestorePoints share={shareFixture()} onShowRuns={() => undefined} />,
      {
        routes: routes([judgement()], (body) => {
          sent = body;
        }),
      },
    );
    await flush(4);
    const badge = document.querySelector<HTMLButtonElement>('[data-slot="suspicion-badge"] button');
    await click(badge);
    await flush(2);
    const dialog = slot("suspicion-dialog") as HTMLElement;
    expect(dialog.textContent).toContain("40 files named like a ransom note (HOW_TO_DECRYPT.txt)");
    expect(dialog.textContent).toContain("3,000 files deleted, 60% of the files before");
    expect(dialog.textContent).toContain("Not available");
    // A restore point that was never judged (made before the detection) counts as without findings.
    expect(slot("last-clean-hint")?.textContent).toContain(
      "The newest restore point without findings is from",
    );

    await click(buttonByText(dialog, "Mark as false alarm"));
    const note = dialog.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(note, "Planned move");
    note.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(1);
    await click(buttonByText(dialog, "Mark as false alarm"));
    await flush(3);
    expect(sent).toEqual({ note: "Planned move" });
  });
});
