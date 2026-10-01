import { describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import {
  UPDATE_PROBLEMS,
  mapUpdaterError,
  nextCheckAt,
  privateNetworksAllowedFor,
} from "./service.js";
import { UpdaterRejectedError, UpdaterUnavailableError } from "./updater-client.js";

describe("what the updater's answers turn into", () => {
  const rejected = (status: number, code: string | null, body: unknown = null) =>
    mapUpdaterError(new UpdaterRejectedError(status, code, body));

  it("names an updater that does not answer, with the reason", () => {
    const problem = mapUpdaterError(new UpdaterUnavailableError("unreachable"));
    expect(problem).toMatchObject({
      status: 409,
      type: UPDATE_PROBLEMS.updaterUnavailable,
      extensions: { reason: "unreachable" },
    });
    expect(problem.detail).toContain("--profile updater");
  });

  it("keeps the meaning of each refusal", () => {
    expect(rejected(409, "busy")).toMatchObject({ status: 409, type: UPDATE_PROBLEMS.busy });
    expect(rejected(409, "running")).toMatchObject({ status: 409, type: UPDATE_PROBLEMS.running });
    expect(rejected(409, "not_finished")).toMatchObject({ status: 409 });
    expect(rejected(409, "not_scheduled")).toMatchObject({
      status: 409,
      type: UPDATE_PROBLEMS.notScheduled,
    });
    expect(rejected(422, "not_newer")).toMatchObject({
      status: 422,
      type: UPDATE_PROBLEMS.versionUnknown,
    });
    const notAllowed = rejected(409, "source_not_allowed");
    expect(notAllowed).toMatchObject({ status: 409, type: UPDATE_PROBLEMS.sourceNotAllowed });
    expect(notAllowed.detail).toContain("RESTOW_UPDATER_SOURCE_HOSTS");
  });

  it("passes the blockers on", () => {
    const blockers = [{ code: "disk_space", detail: "300 MB free" }];
    expect(rejected(409, "blocked", { code: "blocked", blockers })).toMatchObject({
      status: 409,
      type: UPDATE_PROBLEMS.updaterBlocked,
      extensions: { blockers },
    });
    expect(rejected(409, "blocked", null)).toMatchObject({ extensions: { blockers: [] } });
  });

  it("does not leak what it cannot explain", () => {
    const problem = rejected(500, "internal", { code: "internal", message: "stack trace here" });
    expect(problem).toMatchObject({ status: 502, type: UPDATE_PROBLEMS.updaterError });
    expect(problem.detail).not.toContain("stack trace");
    expect(mapUpdaterError(new Error("boom"))).toMatchObject({ status: 502 });
  });

  it("returns a problem it was given unchanged", () => {
    const own = new ProblemError(418, "teapot");
    expect(mapUpdaterError(own)).toBe(own);
  });
});

describe("when the next check is due", () => {
  const now = new Date("2026-10-01T09:00:00.000Z");
  const check = (over: object) => ({
    source: "https://example.test/releases",
    channel: "stable" as const,
    state: "ok" as const,
    checkedAt: "2026-10-01T08:00:00.000Z",
    lastOkAt: "2026-10-01T08:00:00.000Z",
    releases: [],
    error: null,
    ...over,
  });

  it("is at once before the first check", () => {
    expect(nextCheckAt(null, now)).toEqual(now);
  });

  it("is a day after a good check", () => {
    expect(nextCheckAt(check({}), now).toISOString()).toBe("2026-10-02T08:00:00.000Z");
  });

  it("is an hour after a failed check, or when the rate limit lifts if that is later", () => {
    const failed = {
      state: "failed",
      error: { code: "network", status: null, retryAt: null, detail: null },
    };
    expect(nextCheckAt(check(failed), now).toISOString()).toBe("2026-10-01T09:00:00.000Z");
    const limited = {
      state: "failed",
      error: {
        code: "rate_limited",
        status: 403,
        retryAt: "2026-10-01T11:30:00.000Z",
        detail: null,
      },
    };
    expect(nextCheckAt(check(limited), now).toISOString()).toBe("2026-10-01T11:30:00.000Z");
  });
});

describe("where the update check may connect", () => {
  const forge = "https://git.internal.example/api/v1/repos/acme/restow/releases?limit=30";

  it("reaches private networks only where the operator decided so", () => {
    expect(privateNetworksAllowedFor(forge, "settings", {})).toBe(false);
    expect(privateNetworksAllowedFor(forge, "default", {})).toBe(false);
    expect(
      privateNetworksAllowedFor(forge, "settings", {
        RESTOW_UPDATER_SOURCE_HOSTS: "git.internal.example/acme/restow",
      }),
    ).toBe(true);
    expect(
      privateNetworksAllowedFor(forge, "settings", {
        RESTOW_UPDATER_SOURCE_HOSTS: "other.example",
      }),
    ).toBe(false);
    // The environment override is the operator's own address.
    expect(privateNetworksAllowedFor(forge, "environment", {})).toBe(true);
  });
});
