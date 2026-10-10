import { describe, expect, it } from "vitest";
import { FAILURE_CATALOG } from "../failures/catalog.js";
import { FAILURE_CODES } from "../failures/types.js";
import {
  SHARE_ITEM_CAUSES,
  shareCause,
  shareCauseOfCode,
  shareRunCause,
  shareWarningCauses,
} from "./failures.js";
import { SHARE_CAUSE_OF } from "./runner.js";

describe("file share failure causes (section 11)", () => {
  it("has a catalog entry for every cause a runner or mounter code maps to", () => {
    for (const cause of [...Object.values(SHARE_CAUSE_OF), ...Object.values(SHARE_ITEM_CAUSES)]) {
      expect(FAILURE_CODES).toContain(cause);
      expect(FAILURE_CATALOG[cause as keyof typeof FAILURE_CATALOG]?.category).toBe("share");
    }
    for (const code of ["share.runner_lost", "share.runner_stalled", "share.out_of_memory"]) {
      expect(FAILURE_CODES).toContain(code);
    }
  });

  it("maps the runner's and the mounter's codes", () => {
    expect(shareCauseOfCode("mount.auth_failed", "mount: key has expired").params).toEqual({
      reason: "expired",
    });
    expect(shareCauseOfCode("empty_source").code).toBe("share.empty_source");
    expect(
      shareCauseOfCode("include_missing", "the include folder Finance/2026 does not exist").params,
    ).toEqual({ path: "Finance/2026" });
    expect(shareCauseOfCode("something new").code).toBe("share.runner_failed");
    expect(shareCauseOfCode("mount.unreachable").transient).toBe(true);
    expect(shareCauseOfCode("mount.not_found").transient).toBe(false);
  });

  it("redacts secrets from the technical detail", () => {
    const cause = shareCause("share.mount_failed", {
      detail: "mount error: password=hunter2 refused for hunter2",
      extraSecrets: ["hunter2"],
    });
    expect(String(cause.technical.message)).not.toContain("hunter2");
  });

  it("groups items into warning causes, offline files as information only", () => {
    expect(
      shareWarningCauses({
        locked_file: 3,
        read_error: 1,
        acl_unreadable: 2,
        acl_not_restored: 2,
        offline_skipped: 40,
        mystery: 1,
      }),
    ).toEqual([
      { code: "share.acl_partial", count: 4 },
      { code: "share.locked_files", count: 3 },
      { code: "share.read_errors", count: 2 },
    ]);
    expect(shareWarningCauses(null)).toEqual([]);
  });

  it("gives a finished run its cause", () => {
    expect(shareRunCause({ status: "succeeded" })).toBeNull();
    expect(shareRunCause({ status: "cancelled", code: "cancelled" })).toBeNull();
    expect(shareRunCause({ status: "failed", code: "quota_exceeded" })?.code).toBe(
      "share.quota_exceeded",
    );
    const warning = shareRunCause({ status: "warning", items: { locked_file: 23 } });
    expect(warning).toMatchObject({ code: "share.locked_files", params: { count: 23 } });
  });
});
