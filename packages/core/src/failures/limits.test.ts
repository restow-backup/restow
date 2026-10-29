import { describe, expect, it } from "vitest";
import { catalogEntry } from "./catalog.js";
import {
  isNotBackedUpFailure,
  isServiceLimitedFailure,
  NOT_BACKED_UP_CAUSES,
  notBackedUpReason,
  SERVICE_LIMIT_CAUSES,
} from "./limits.js";

describe("runs that were not backed up because the account is inactive", () => {
  it("are failed runs with an inactive cause, apart from the held-back ones", () => {
    expect(isNotBackedUpFailure("failed", { code: "graph.mailbox_inactive" })).toBe(true);
    expect(isNotBackedUpFailure("failed", { code: "config.object_inactive" })).toBe(true);
    expect(isNotBackedUpFailure("completed", { code: "graph.mailbox_inactive" })).toBe(false);
    expect(isNotBackedUpFailure("failed", { code: "config.object_orphaned" })).toBe(false);
    expect(isNotBackedUpFailure("failed", { code: "graph.mailbox_not_licensed" })).toBe(false);
    expect(isNotBackedUpFailure("failed", null)).toBe(false);
    expect(isServiceLimitedFailure("failed", { code: "graph.mailbox_inactive" })).toBe(false);
    for (const code of NOT_BACKED_UP_CAUSES) {
      expect(SERVICE_LIMIT_CAUSES as readonly string[]).not.toContain(code);
      expect(catalogEntry(code)?.retryable).toBe(false);
      expect(catalogEntry(code)?.transient).toBe(false);
    }
  });

  it("carry their reason", () => {
    const failure = (reason: unknown) => ({ code: "graph.mailbox_inactive", params: { reason } });
    expect(notBackedUpReason("failed", failure("account_disabled"))).toBe("account_disabled");
    expect(notBackedUpReason("failed", failure("no_license"))).toBe("no_license");
    expect(notBackedUpReason("failed", failure(undefined))).toBe("no_license");
    expect(notBackedUpReason("failed", { code: "graph.throttled" })).toBeNull();
  });

  it("point at what brings the mailbox back", () => {
    const steps = (reason: string) =>
      catalogEntry("graph.mailbox_inactive")
        ?.steps({ reason })
        .map((step) => step.id);
    expect(steps("account_disabled")).toEqual(["enable_account", "sync_directory"]);
    expect(steps("no_license")).toEqual(["assign_license", "sync_directory"]);
  });
});
