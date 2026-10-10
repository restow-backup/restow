import { describe, expect, it } from "vitest";
import {
  type CopyShareFacts,
  checkCopyRules,
  checkMirrorCount,
  cleanTargetFolder,
  pickCopyRestorePoint,
  sameShareLocation,
} from "./copy.js";

const share = (id: string, over: Partial<CopyShareFacts> = {}): CopyShareFacts => ({
  id,
  protocol: "smb",
  server: "files.example.test",
  shareName: "data",
  exportPath: null,
  subfolder: "",
  allowRestore: true,
  retiredAt: null,
  ...over,
});

describe("copy job safety rules (4.10)", () => {
  it("rule 1: the target allows restores", () => {
    expect(
      checkCopyRules(share("a"), share("b", { shareName: "other", allowRestore: false }), {
        mode: "overwrite",
        targetFolder: "copy",
      }),
    ).toEqual({ ok: false, code: "share.restore_not_allowed", rule: "restore_not_allowed" });
  });

  it("rule 2: never the same share, by id or by location", () => {
    const job = { mode: "overwrite" as const, targetFolder: "Copy" };
    expect(checkCopyRules(share("a"), share("a"), job)).toMatchObject({ rule: "same_share" });
    // Another share row for the same \\files\data: the root overlaps everything.
    expect(checkCopyRules(share("a"), share("b"), job)).toMatchObject({ rule: "same_share" });
    expect(
      checkCopyRules(share("a", { subfolder: "HR" }), share("b", { subfolder: "Finance" }), job),
    ).toEqual({ ok: true });
    expect(
      checkCopyRules(share("a", { subfolder: "Finance" }), share("b", { subfolder: "finance" }), {
        mode: "overwrite",
        targetFolder: "x",
      }),
    ).toMatchObject({ rule: "same_share" });
    expect(
      checkCopyRules(
        share("a", { subfolder: "Finance/2026" }),
        share("b", { subfolder: "Finance" }),
        {
          mode: "overwrite",
          targetFolder: "2026",
        },
      ),
    ).toMatchObject({ rule: "same_share" });
    expect(
      sameShareLocation(
        share("a", { server: "fs1", address: "10.0.0.5" }),
        share("b", { server: "10.0.0.5", address: "10.0.0.5" }),
        "x",
      ),
    ).toBe(true);
    expect(
      sameShareLocation(
        share("a", { protocol: "nfs", shareName: null, exportPath: "/srv/a" }),
        share("b", { protocol: "nfs", shareName: null, exportPath: "/srv/b" }),
        "",
      ),
    ).toBe(false);
    expect(sameShareLocation(share("a"), share("b", { shareName: "DATA2" }), "")).toBe(false);
  });

  it("rule 3: mirror never into a share root", () => {
    const target = share("b", { shareName: "replica" });
    expect(checkCopyRules(share("a"), target, { mode: "mirror", targetFolder: "/" })).toMatchObject(
      {
        ok: false,
        code: "share.copy_unsafe_target",
        rule: "share_root",
      },
    );
    expect(checkCopyRules(share("a"), target, { mode: "overwrite", targetFolder: "" })).toEqual({
      ok: true,
    });
    expect(checkCopyRules(share("a"), target, { mode: "mirror", targetFolder: "Replica" })).toEqual(
      {
        ok: true,
      },
    );
  });

  it("refuses a retired share", () => {
    expect(
      checkCopyRules(share("a", { retiredAt: new Date() }), share("b", { shareName: "r" }), {
        mode: "overwrite",
        targetFolder: "x",
      }),
    ).toMatchObject({ ok: false, rule: "retired" });
  });

  it("rules 5 and 6: no empty or halved restore point for a mirror, unless forced", () => {
    expect(checkMirrorCount(0, 10, true)).toMatchObject({ ok: false, rule: "empty" });
    expect(checkMirrorCount(4, 10, false)).toMatchObject({ ok: false, rule: "halved" });
    expect(checkMirrorCount(4, 10, true)).toEqual({ ok: true });
    expect(checkMirrorCount(5, 10, false)).toEqual({ ok: true });
    expect(checkMirrorCount(5, null, false)).toEqual({ ok: true });
  });

  it("copies the newest verified restore point", () => {
    const snaps = [
      { id: "s1", resticSnapshotId: "aaaa1111", sequence: 1, files: 3 },
      { id: "s2", resticSnapshotId: "bbbb2222", sequence: 2, files: 3 },
      { id: "s3", resticSnapshotId: "cccc3333", sequence: 3, files: 3 },
    ];
    const reports = [
      {
        kind: "restore_test" as const,
        snapshotId: "aaaa1111",
        readiness: "green" as const,
        checkedAt: new Date(1),
      },
      {
        kind: "restore_test" as const,
        snapshotId: "bbbb2222",
        readiness: "green" as const,
        checkedAt: new Date(2),
      },
      {
        kind: "restore_test" as const,
        snapshotId: "cccc3333",
        readiness: "red" as const,
        checkedAt: new Date(3),
      },
    ];
    expect(pickCopyRestorePoint(snaps, reports)?.id).toBe("s2");
    expect(pickCopyRestorePoint(snaps, [])).toBeNull();
    expect(cleanTargetFolder("/a//b/")).toBe("a/b");
  });
});
