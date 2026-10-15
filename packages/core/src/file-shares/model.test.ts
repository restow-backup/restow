import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOUNTER_RUNNER_CAPS,
  FILE_SHARE_SETTINGS_DEFAULTS,
  SHARE_SYSTEM_FILE_PATTERNS,
  fileShareRepositoryKey,
  fileShareRepositoryPrefix,
  fileShareSettingsOf,
  goMemLimitMiB,
  mounterRunnerCapsFromEnv,
  shareExcludePatterns,
  shareIncludes,
  shareRelativePath,
  snapshotPathOf,
} from "./model.js";

const ID = "6f1c3a52-6d3f-4d70-9a52-6f9d8c1e2b3a";

describe("file share repository location", () => {
  it("lives under file-shares/<id>/ with its own cache key", () => {
    expect(fileShareRepositoryPrefix(ID)).toBe(`file-shares/${ID}/`);
    expect(fileShareRepositoryKey(ID)).toBe(`file-share-${ID}`);
  });
});

describe("installation settings (7.4)", () => {
  it("fills in every default", () => {
    expect(fileShareSettingsOf({})).toEqual(FILE_SHARE_SETTINGS_DEFAULTS);
    expect(fileShareSettingsOf(null)).toEqual(FILE_SHARE_SETTINGS_DEFAULTS);
  });

  it("applies the bounds and the mounter's caps", () => {
    const settings = fileShareSettingsOf(
      {
        maxConcurrentRunners: 50,
        runnerMemoryMiB: 100,
        goMemLimitPercent: 99,
        maxRunHours: 0,
        defaultReadConcurrency: 40,
        tenantsMayUsePrivateNetworks: "yes",
        defaultShareQuotaGib: -3,
        tenantShareQuotaGib: 10.4,
        tenantShareQuotaGibByTenant: { a: 5, b: -1, c: "x" },
        catalog: { enabled: false, maxEntriesPerShare: 5 },
      },
      { maxRunners: 4, maxMemoryMiB: 4096 },
    );
    expect(settings).toMatchObject({
      maxConcurrentRunners: 4,
      runnerMemoryMiB: 512,
      goMemLimitPercent: 90,
      maxRunHours: 1,
      defaultReadConcurrency: 16,
      tenantsMayUsePrivateNetworks: false,
      defaultShareQuotaGib: 0,
      tenantShareQuotaGib: 10,
      tenantShareQuotaGibByTenant: { a: 5 },
      catalog: { enabled: false, maxEntriesPerShare: 1000 },
    });
  });

  it("keeps a default above a smaller mounter cap inside the cap", () => {
    expect(fileShareSettingsOf({}, { maxRunners: 1, maxMemoryMiB: 1024 })).toMatchObject({
      maxConcurrentRunners: 1,
      runnerMemoryMiB: 1024,
    });
  });

  it("derives GOMEMLIMIT from the runner memory", () => {
    expect(goMemLimitMiB({ runnerMemoryMiB: 2048, goMemLimitPercent: 80 })).toBe(1638);
  });

  it("reads the mounter's caps from its variables", () => {
    expect(mounterRunnerCapsFromEnv({})).toEqual(DEFAULT_MOUNTER_RUNNER_CAPS);
    expect(
      mounterRunnerCapsFromEnv({
        RESTOW_MOUNTER_MAX_RUNNERS: "3",
        RESTOW_MOUNTER_RUNNER_MAX_MEMORY_MIB: "nope",
      }),
    ).toEqual({ maxRunners: 3, maxMemoryMiB: 16384 });
  });
});

describe("job excludes (7.5)", () => {
  it("adds the preset unless it is switched off, and file types as patterns", () => {
    const patterns = shareExcludePatterns({
      excludes: ["*.bak", " ", "*.bak", "#archive"],
      fileTypes: { exclude: ["iso", ".vhdx", "*.mp4", "bad ext", ""] },
    });
    expect(patterns.slice(0, 2)).toEqual(["*.bak", "#archive"]);
    for (const preset of SHARE_SYSTEM_FILE_PATTERNS) {
      expect(patterns).toContain(preset);
    }
    expect(patterns.slice(-3)).toEqual(["*.iso", "*.vhdx", "*.mp4"]);
    expect(shareExcludePatterns({ presets: { systemFiles: false } })).toEqual([]);
    expect(shareExcludePatterns(null)).toEqual([...SHARE_SYSTEM_FILE_PATTERNS]);
  });

  it("cleans include folders", () => {
    expect(shareIncludes(["/Finance/", "Finance", "HR//2026", ""])).toEqual(["Finance", "HR/2026"]);
    expect(shareIncludes(undefined)).toEqual([]);
  });

  it("maps share paths to restore point paths and back", () => {
    expect(snapshotPathOf("")).toBe("/share");
    expect(snapshotPathOf("/a/b/")).toBe("/share/a/b");
    expect(shareRelativePath("/share")).toBe("");
    expect(shareRelativePath("/share/a/b")).toBe("a/b");
    expect(shareRelativePath("/.restow/acls.jsonl.gz")).toBeNull();
    expect(shareRelativePath("/shared/x")).toBeNull();
    expect(shareRelativePath("/tmp/x/share/a", "/tmp/x/share")).toBe("a");
  });
});
