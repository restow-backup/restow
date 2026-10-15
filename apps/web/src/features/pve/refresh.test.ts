import { describe, expect, it } from "vitest";
import {
  ACTIVE_REFRESH_MS,
  guestRefreshMs,
  OVERVIEW_REFRESH_MS,
  overviewRefreshMs,
  type PveGuest,
  type PveGuestDetail,
  type PveOverview,
  type PveRun,
} from "./api.js";

const overview = (activity: PveGuest["activity"][]) =>
  ({ guests: activity.map((value) => ({ activity: value })) }) as unknown as PveOverview;
const detail = (statuses: PveRun["status"][]) =>
  ({ runs: statuses.map((status) => ({ status })) }) as unknown as PveGuestDetail;

describe("overviewRefreshMs", () => {
  it("refreshes slowly while nothing waits or runs", () => {
    expect(overviewRefreshMs(undefined)).toBe(OVERVIEW_REFRESH_MS);
    expect(overviewRefreshMs(overview([null, undefined]))).toBe(OVERVIEW_REFRESH_MS);
  });

  it("refreshes often while a guest waits for its node or backs up", () => {
    expect(overviewRefreshMs(overview([null, "queued"]))).toBe(ACTIVE_REFRESH_MS);
    expect(overviewRefreshMs(overview(["running"]))).toBe(ACTIVE_REFRESH_MS);
  });
});

describe("guestRefreshMs", () => {
  it("refreshes often only while a run is going", () => {
    expect(guestRefreshMs(undefined)).toBe(15_000);
    expect(guestRefreshMs(detail(["succeeded", "failed"]))).toBe(15_000);
    expect(guestRefreshMs(detail(["running", "succeeded"]))).toBe(ACTIVE_REFRESH_MS);
  });
});
