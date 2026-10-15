import { describe, expect, it } from "vitest";
import { nextProgress } from "./runs.js";

describe("nextProgress", () => {
  const at = new Date("2026-10-15T10:00:00Z");
  const later = (seconds: number) => new Date(at.getTime() + seconds * 1000);

  it("has no throughput before the second report", () => {
    expect(nextProgress(null, { bytesDone: 10, bytesTotal: 100, bytesUploaded: 4 }, at)).toEqual({
      bytesDone: 10,
      bytesTotal: 100,
      bytesUploaded: 4,
      bytesPerSecond: null,
      at: at.toISOString(),
    });
  });

  it("measures what was read between two reports and smooths it with the last figure", () => {
    const first = nextProgress(null, { bytesDone: 0 }, at);
    const second = nextProgress(first, { bytesDone: 500 }, later(5));
    expect(second.bytesPerSecond).toBe(100);
    const third = nextProgress(second, { bytesDone: 1500 }, later(10));
    expect(third.bytesPerSecond).toBe(150);
  });

  it("keeps the last throughput when the count went back (a retried disk) or no time passed", () => {
    const first = { ...nextProgress(null, { bytesDone: 900 }, at), bytesPerSecond: 70 };
    expect(nextProgress(first, { bytesDone: 100 }, later(5)).bytesPerSecond).toBe(70);
    expect(nextProgress(first, { bytesDone: 1000 }, at).bytesPerSecond).toBe(70);
  });

  it("does not take a total below what was read, nor a zero one", () => {
    expect(nextProgress(null, { bytesDone: 10, bytesTotal: 5 }, at).bytesTotal).toBeNull();
    expect(nextProgress(null, { bytesDone: 0, bytesTotal: 0 }, at).bytesTotal).toBeNull();
    expect(nextProgress(null, { bytesDone: 5, bytesTotal: 5 }, at).bytesTotal).toBe(5);
  });
});
