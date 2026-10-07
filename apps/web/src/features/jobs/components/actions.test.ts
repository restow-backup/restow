import { describe, expect, it } from "vitest";

import type { BackupTarget, Job } from "../api";
import { backupUnavailableKey } from "./actions";

function target(lastJob: Pick<Job, "status"> | null, blocked: BackupTarget["blocked"] = null) {
  return { blocked, lastJob } as unknown as BackupTarget;
}

describe("why Back up now is unavailable", () => {
  it("tells a waiting backup from a running one", () => {
    expect(backupUnavailableKey(target({ status: "queued" }))).toBe("blocked.waiting");
    expect(backupUnavailableKey(target({ status: "active" }))).toBe("blocked.running");
  });

  it("names the object's own block first, and nothing when it can run", () => {
    expect(backupUnavailableKey(target({ status: "active" }, "excluded"))).toBe("blocked.excluded");
    expect(backupUnavailableKey(target({ status: "completed" }))).toBeNull();
    expect(backupUnavailableKey(target(null))).toBeNull();
  });
});
