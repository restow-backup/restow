import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveBackupSize, PveGuest, PveGuestBackupSizes, PveRestorePoint } from "./api";
import { BackupSizeCell, lastFollowUp, newDataPoints } from "./backup-size";
import { BackupSizeLine } from "./guest-cells";
import { FollowUpNote } from "./guest-page";
import { guestProtection } from "./inventory-section";
import { GuestState } from "./pve-page";

/**
 * Sizes of a guest's backups (#58, #61): what the newest restore point contains,
 * what the last run added, and a container backup that could not read everything.
 */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function guest(backups: PveGuestBackupSizes | undefined, over: Partial<PveGuest> = {}): PveGuest {
  return {
    id: "g-1",
    clusterId: "c-1",
    vmid: 117,
    kind: "ct",
    name: "paperless-ngx",
    node: "pmx02",
    status: "running",
    template: false,
    privileged: false,
    present: true,
    diskBytes: 9 * GiB,
    jobId: "j-1",
    jobName: "Nightly",
    lastBackupAt: "2026-10-14T00:02:23.000Z",
    lastSuccessAt: "2026-10-14T00:02:31.000Z",
    lastRunStatus: "succeeded",
    lastRunError: null,
    bitmapState: null,
    backups,
    attention: [],
    ...over,
  } as PveGuest;
}

const sizes = (unreadable = 0): PveGuestBackupSizes => ({
  first: { at: "2026-10-12T12:35:18.000Z", contains: 9.4 * GiB, added: 3.1 * GiB, unreadable: 0 },
  last: { at: "2026-10-13T22:02:23.000Z", contains: 9.44 * GiB, added: 2.5 * MiB, unreadable },
});

const html = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

describe("BackupSizeCell (the inventory row, #58)", () => {
  it("says how large the first backup was and when, and what the last follow-up added", () => {
    const out = html(<BackupSizeCell guest={guest(sizes())} />);
    expect(out).toMatch(/data-slot="pve-backup-first">First backup: 3\.1 GB on Oct 12</);
    expect(out).toMatch(/data-slot="pve-backup-last-follow-up">Last follow-up: \+2\.5 MB</);
    // The tooltip adds the full time of the first backup and what the newest point contains.
    expect(out).toContain("First backup on");
    expect(out).toMatch(/9\.4\d? GB in the backup/);
  });

  it("shows the average follow-up as text, not only in the tooltip", () => {
    const out = html(
      <BackupSizeCell guest={guest({ ...sizes(), followUp: { added: 180 * MiB, points: 7 } })} />,
    );
    expect(out).toMatch(
      /data-slot="pve-backup-follow-up">Average follow-up: \+180 MB \(last 7 backups\)</,
    );
    // Without a follow-up backup there is no average, not a "+0 B".
    expect(html(<BackupSizeCell guest={guest({ ...sizes(), followUp: null })} />)).not.toContain(
      "Average follow-up",
    );
  });

  it("says so while the first backup is the only one", () => {
    const first = { ...sizes().first, sequence: 1 } as PveBackupSize;
    const out = html(<BackupSizeCell guest={guest({ first, last: first })} />);
    expect(out).toContain("First backup: 3.1 GB on Oct 12");
    expect(out).toContain("No follow-up backup yet");
    expect(out).not.toContain("Last follow-up");
  });

  it("goes by the sequence the server sends, not by the time", () => {
    const base = sizes();
    const first = { ...base.first, sequence: 4 } as PveBackupSize;
    // Two points of the same second: the newer one is still a follow-up.
    const last = { ...base.last, at: first.at, sequence: 5 } as PveBackupSize;
    expect(lastFollowUp({ first, last })?.added).toBe(2.5 * MiB);
    expect(lastFollowUp({ first, last: { ...last, sequence: 4 } })).toBeNull();
    // Older servers send no sequence: the time decides.
    expect(lastFollowUp(sizes())?.added).toBe(2.5 * MiB);
    expect(lastFollowUp({ first: base.first, last: base.first })).toBeNull();
    expect(lastFollowUp(undefined)).toBeNull();
  });

  it("says so when there is no backup yet, also on servers before 0.3.5", () => {
    expect(html(<BackupSizeCell guest={guest(undefined)} />)).toContain("No backup yet");
    expect(html(<BackupSizeCell guest={guest({ first: null, last: null })} />)).toContain(
      "No backup yet",
    );
  });

  it("leaves out the follow-up line when the restore point did not record what it added", () => {
    const out = html(
      <BackupSizeCell
        guest={guest({
          first: sizes().first,
          last: { at: "2026-10-13T22:02:23.000Z", contains: GiB, added: null, unreadable: 0 },
        })}
      />,
    );
    expect(out).toContain("First backup:");
    expect(out).not.toContain("Last follow-up");
    expect(out).not.toContain("No follow-up backup yet");
  });

  it("falls back to what the newest point contains without a first backup", () => {
    const out = html(
      <BackupSizeCell
        guest={guest({ first: null, last: { at: "x", contains: GiB, added: null, unreadable: 0 } })}
      />,
    );
    expect(out).toContain("1 GB in the backup");
  });
});

describe("the new data per backup (#58)", () => {
  const point = (sequence: number, added: number | null, over: Partial<PveRestorePoint> = {}) =>
    ({
      id: `p-${sequence}`,
      sequence,
      kind: "ct",
      backupAt: new Date(Date.UTC(2026, 9, sequence)).toISOString(),
      byteSize: 9 * GiB,
      added,
      backupType: sequence === 1 ? "first" : "incremental",
      disks: [],
      ...over,
    }) as unknown as PveRestorePoint;

  it("takes the newest 30 points that recorded it, oldest first, with their type", () => {
    const points = Array.from({ length: 40 }, (_, index) =>
      point(40 - index, index === 3 ? null : (index + 1) * MiB),
    );
    const bars = newDataPoints(points);
    expect(bars).toHaveLength(30);
    expect(bars.at(-1)?.id).toBe("p-40");
    expect(bars.map((bar) => bar.id)).not.toContain("p-37");
    expect(bars[0]?.at < (bars[1]?.at ?? "")).toBe(true);
    expect(newDataPoints([point(1, GiB), point(2, MiB)]).map((bar) => bar.type)).toEqual([
      "first",
      "incremental",
    ]);
    // Servers before 0.4.0 send no type: an incremental bar.
    expect(newDataPoints([point(3, MiB, { backupType: undefined })])[0]?.type).toBe("incremental");
  });
});

describe("an incomplete container backup", () => {
  it("is not shown as succeeded, neither in the state nor in the inventory", () => {
    const g = guest(sizes(42));
    const state = html(<GuestState guest={g} />);
    expect(state).toContain("Incomplete backup");
    expect(state).not.toContain('data-status="succeeded"');
    expect(guestProtection(g)).toBe("incomplete");
    expect(guestProtection(guest(sizes()))).toBe("protected");
  });
});

describe("the guest page", () => {
  it("says what a follow-up backup adds on average and over how many backups", () => {
    expect(html(<FollowUpNote followUp={{ added: 2.5 * MiB, points: 1 }} />)).toContain(
      "A follow-up backup adds +2.5 MB on average (last 1 backup).",
    );
  });
});

describe("the Backup column of the guests table (#58)", () => {
  it("says on one line how large the first backup was and what the last one added", () => {
    const line = html(<BackupSizeLine guest={guest(sizes())} />);
    expect(line).toContain("First: 3.1 GB on Oct 12");
    expect(line).toContain("Last: +2.5 MB");
  });

  it("leaves out the follow-up while the first backup is the only one", () => {
    const first = sizes().first;
    const line = html(<BackupSizeLine guest={guest({ first, last: first })} />);
    expect(line).toContain("First:");
    expect(line).not.toContain("Last:");
    expect(html(<BackupSizeLine guest={guest(undefined)} />)).toContain("No backup yet");
  });
});
