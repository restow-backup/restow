import type { StoredUpdateCheck, StoredUpdateRelease } from "@restow/db";
import { describe, expect, it } from "vitest";
import { defaultSource, parseEnvironmentSource } from "./source.js";
import { UpdateStateCache, newerThan, releasesOf } from "./state.js";

function release(version: string, prerelease = false): StoredUpdateRelease {
  return {
    version,
    tag: `v${version}`,
    name: null,
    publishedAt: "2026-10-01T08:00:00.000Z",
    url: `https://github.com/restow-backup/restow/releases/tag/v${version}`,
    prerelease,
    notes: null,
    notesTruncated: false,
    digests: {},
  };
}

function check(overrides: Partial<StoredUpdateCheck> = {}): StoredUpdateCheck {
  return {
    source: defaultSource().releasesUrl,
    channel: "stable",
    state: "ok",
    checkedAt: "2026-10-01T09:00:00.000Z",
    lastOkAt: "2026-10-01T09:00:00.000Z",
    releases: [release("0.3.0"), release("0.2.0")],
    error: null,
    ...overrides,
  };
}

function cache(running: string | null, environmentUrl?: string) {
  return new UpdateStateCache(running, environmentUrl);
}

function enable(target: UpdateStateCache, stored: StoredUpdateCheck | null, channel = "stable") {
  target.set({
    enabled: true,
    channel: channel as "stable" | "beta",
    source: defaultSource(),
    origin: "default",
    check: stored,
    maintenance: null,
  });
}

describe("the version document", () => {
  it("is off until somebody turned the check on, and says nothing about releases", () => {
    expect(cache("0.1.0").current()).toEqual({
      running: "0.1.0",
      commit: null,
      latest: null,
      updateAvailable: null,
      releaseUrl: null,
      updateCheck: "disabled",
      checkedAt: null,
      channel: "stable",
      latestTag: null,
      publishedAt: null,
      checkError: null,
      maintenance: null,
    });
  });

  it("reports the commit the build was made from", () => {
    expect(new UpdateStateCache("0.1.0", undefined, "9272693").current().commit).toBe("9272693");
  });

  it("is pending until the first check has finished", () => {
    const state = cache("0.1.0");
    enable(state, null);
    expect(state.current()).toMatchObject({
      updateCheck: "pending",
      latest: null,
      checkedAt: null,
    });
  });

  it("reports the newest release of the channel and whether it is newer", () => {
    const state = cache("0.2.0");
    enable(state, check());
    expect(state.current()).toMatchObject({
      running: "0.2.0",
      latest: "0.3.0",
      latestTag: "v0.3.0",
      updateAvailable: true,
      updateCheck: "ok",
      publishedAt: "2026-10-01T08:00:00.000Z",
      checkedAt: "2026-10-01T09:00:00.000Z",
      releaseUrl: "https://github.com/restow-backup/restow/releases/tag/v0.3.0",
    });
  });

  it("is up to date on the newest version and never claims an update for an unknown build", () => {
    const current = cache("0.3.0");
    enable(current, check());
    expect(current.current().updateAvailable).toBe(false);
    const unknown = cache(null);
    enable(unknown, check());
    expect(unknown.current().updateAvailable).toBeNull();
  });

  it("keeps the last good release when a later check failed, and says why", () => {
    const state = cache("0.2.0");
    enable(
      state,
      check({
        state: "failed",
        checkedAt: "2026-10-02T09:00:00.000Z",
        error: { code: "rate_limited", status: 403, retryAt: null, detail: null },
      }),
    );
    expect(state.current()).toMatchObject({
      updateCheck: "failed",
      latest: "0.3.0",
      updateAvailable: true,
      checkError: "rate_limited",
    });
  });

  it("does not use a result cached for another source or channel", () => {
    const state = cache("0.1.0");
    enable(state, check({ channel: "beta" }));
    expect(state.current()).toMatchObject({ updateCheck: "pending", latest: null });
    state.set({ ...state.get(), check: check({ source: "https://elsewhere.example/releases" }) });
    expect(state.current().updateCheck).toBe("pending");
  });

  it("shows pre-releases on the beta channel only, compared by semantic version", () => {
    const state = cache("0.3.0-beta.2");
    state.set({
      enabled: true,
      channel: "beta",
      source: defaultSource(),
      origin: "default",
      check: check({
        channel: "beta",
        releases: [release("0.3.0-beta.10", true), release("0.3.0-beta.2", true)],
      }),
      maintenance: null,
    });
    expect(state.current()).toMatchObject({
      channel: "beta",
      latest: "0.3.0-beta.10",
      updateAvailable: true,
    });
  });

  it("carries an announced maintenance for integrations to see", () => {
    const state = cache("0.1.0");
    state.setMaintenance({
      phase: "scheduled",
      targetVersion: "0.2.0",
      startsAt: "2026-10-01T12:00:00.000Z",
    });
    expect(state.current().maintenance).toEqual({
      phase: "scheduled",
      targetVersion: "0.2.0",
      startsAt: "2026-10-01T12:00:00.000Z",
    });
  });
});

describe("the environment override", () => {
  it("turns the check on from the start, reading the address it names", () => {
    const state = cache("0.1.0", "https://api.github.com/repos/acme/restow/releases/latest");
    expect(state.get()).toMatchObject({ enabled: true, origin: "environment" });
    expect(state.get().source.releasesUrl).toBe(
      "https://api.github.com/repos/acme/restow/releases/latest",
    );
    expect(state.current().updateCheck).toBe("pending");
  });

  it("ignores an address that is not https", () => {
    expect(cache("0.1.0", "http://example.com/releases").get()).toMatchObject({
      enabled: false,
      origin: "default",
    });
    expect(parseEnvironmentSource("http://example.com/releases")).toBeNull();
  });
});

describe("candidates", () => {
  it("lists releases newer than the running version, and none when it is unknown", () => {
    const releases = [release("0.3.0"), release("0.2.0"), release("0.1.0")];
    expect(newerThan(releases, "0.2.0").map((entry) => entry.version)).toEqual(["0.3.0"]);
    expect(newerThan(releases, "0.3.0")).toEqual([]);
    expect(newerThan(releases, null)).toEqual([]);
    expect(newerThan(releases, "dev")).toEqual([]);
  });

  it("offers a stable release to a pre-release of it", () => {
    expect(newerThan([release("0.2.0")], "0.2.0-rc.1").map((entry) => entry.version)).toEqual([
      "0.2.0",
    ]);
  });

  it("takes releases only from a check of the current source and channel", () => {
    const source = defaultSource();
    expect(releasesOf(check(), source, "stable")).toHaveLength(2);
    expect(releasesOf(check(), source, "beta")).toEqual([]);
    expect(releasesOf(null, source, "stable")).toEqual([]);
  });
});
