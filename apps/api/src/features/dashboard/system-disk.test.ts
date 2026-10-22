import { describe, expect, it } from "vitest";
import { freeSpaceTrend } from "./system-disk.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();

describe("the free space trend of the system disk", () => {
  it("is a straight line through the last week, with the day the disk is full", () => {
    const samples = [72, 48, 24, 0].map((hours, index) => ({
      at: at(hours),
      freeBytes: 40e9 - index * 5e9,
    }));
    expect(freeSpaceTrend(samples, NOW)).toEqual({
      bytesPerDay: -5e9,
      fullOn: new Date(NOW.getTime() + 5 * 24 * HOUR).toISOString(),
      basisHours: 72,
    });
  });

  it("names no day while the free space does not shrink", () => {
    const samples = [
      { at: at(24), freeBytes: 10e9 },
      { at: at(0), freeBytes: 12e9 },
    ];
    expect(freeSpaceTrend(samples, NOW)).toMatchObject({ bytesPerDay: 2e9, fullOn: null });
  });

  it("needs six hours of history, and reads only the last week", () => {
    expect(freeSpaceTrend([{ at: at(0), freeBytes: 1 }], NOW)).toBeNull();
    expect(
      freeSpaceTrend(
        [
          { at: at(2), freeBytes: 2 },
          { at: at(0), freeBytes: 1 },
        ],
        NOW,
      ),
    ).toBeNull();
    expect(
      freeSpaceTrend(
        [
          { at: at(24 * 30), freeBytes: 99e9 },
          { at: at(12), freeBytes: 10e9 },
          { at: at(0), freeBytes: 10e9 },
        ],
        NOW,
      ),
    ).toMatchObject({ bytesPerDay: 0, basisHours: 12 });
  });
});
