import { describe, expect, it } from "vitest";

import { mailObjectPath } from "../backup/exchange/paths.js";
import { messageObjectPath } from "../backup/imap/paths.js";
import { catalogEntry } from "./catalog.js";
import { classifyFailure } from "./classify.js";
import {
  type LatestBackupFact,
  UNKNOWN_WARNING_CAUSE,
  type WarningAckFact,
  acknowledgeRefusal,
  evaluateWarning,
  isWarning,
  locateFailedItem,
  normalizeCauses,
} from "./warnings.js";

function latest(
  outcome: LatestBackupFact["outcome"],
  causes: string[] = [],
  failedItems = causes.length,
): LatestBackupFact {
  return {
    runId: "run-2",
    outcome,
    finishedAt: "2026-10-07T10:00:00.000Z",
    failedItems,
    causes,
  };
}

const ack = (causes: string[]): WarningAckFact => ({
  acknowledgedAt: "2026-10-06T10:00:00.000Z",
  causes,
  runId: "run-1",
});

describe("normalizeCauses", () => {
  it("makes a sorted set and reads a missing code as unknown", () => {
    expect(
      normalizeCauses(["graph.throttled", null, "graph.item_too_large", "graph.throttled"]),
    ).toEqual(["graph.item_too_large", "graph.throttled", UNKNOWN_WARNING_CAUSE]);
    expect(normalizeCauses([" ", undefined])).toEqual([UNKNOWN_WARNING_CAUSE]);
    expect(normalizeCauses([])).toEqual([]);
  });
});

describe("evaluateWarning", () => {
  it("reports nothing without a run or after a complete one, whatever was acknowledged", () => {
    expect(evaluateWarning(null, null, false).state).toBe("none");
    expect(evaluateWarning(latest("succeeded"), ack(["graph.item_too_large"]), false)).toEqual({
      state: "none",
      causes: [],
      newCauses: [],
      ackSuperseded: false,
    });
  });

  it("keeps a failed backup red: an acknowledgement never covers it", () => {
    const evaluation = evaluateWarning(latest("failed"), ack(["graph.item_too_large"]), false);
    expect(evaluation.state).toBe("failed");
    expect(evaluation.ackSuperseded).toBe(true);
  });

  it("opens a warning without an acknowledgement", () => {
    expect(evaluateWarning(latest("partial", ["graph.item_too_large"]), null, false)).toEqual({
      state: "open",
      causes: ["graph.item_too_large"],
      newCauses: ["graph.item_too_large"],
      ackSuperseded: false,
    });
  });

  it("reads a partial run without causes as one unknown cause", () => {
    expect(evaluateWarning(latest("partial", [], 3), null, false).causes).toEqual([
      UNKNOWN_WARNING_CAUSE,
    ]);
    expect(
      evaluateWarning(latest("partial", [], 3), ack([UNKNOWN_WARNING_CAUSE]), false).state,
    ).toBe("acknowledged");
  });

  it("hides a warning whose causes were all acknowledged", () => {
    const evaluation = evaluateWarning(
      latest("partial", ["graph.item_too_large"]),
      ack(["graph.item_too_large", "graph.item_unreadable"]),
      false,
    );
    expect(evaluation).toEqual({
      state: "acknowledged",
      causes: ["graph.item_too_large"],
      newCauses: [],
      ackSuperseded: false,
    });
  });

  it("shows the warning again for a new cause, naming it", () => {
    const evaluation = evaluateWarning(
      latest("partial", ["graph.item_too_large", "graph.throttled"]),
      ack(["graph.item_too_large"]),
      false,
    );
    expect(evaluation.state).toBe("open");
    expect(evaluation.newCauses).toEqual(["graph.throttled"]);
    expect(evaluation.ackSuperseded).toBe(true);
  });

  it("shows the warning again after a run that failed outright in between", () => {
    const evaluation = evaluateWarning(
      latest("partial", ["graph.item_too_large"]),
      ack(["graph.item_too_large"]),
      true,
    );
    expect(evaluation.state).toBe("open");
    expect(evaluation.newCauses).toEqual([]);
    expect(evaluation.ackSuperseded).toBe(true);
  });
});

describe("acknowledgeRefusal", () => {
  it("accepts a warning only", () => {
    expect(acknowledgeRefusal(latest("partial", ["x"]))).toBeNull();
    expect(acknowledgeRefusal(latest("failed"))).toBe("failed");
    expect(acknowledgeRefusal(latest("succeeded"))).toBe("no_warning");
    expect(acknowledgeRefusal(null)).toBe("no_warning");
    expect(isWarning(latest("partial", ["x"]))).toBe(true);
    expect(isWarning(latest("failed"))).toBe(false);
  });
});

describe("locateFailedItem", () => {
  it("splits a mailbox path into area, folder, subject and id digest", () => {
    const path = mailObjectPath("mail/Inbox/Projects", "Quarterly report", "AAMkAD-graph-id");
    const location = locateFailedItem(path);
    expect(location.area).toBe("mail");
    expect(location.folder).toBe("Inbox/Projects");
    expect(location.name).toBe("Quarterly report");
    expect(location.itemId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("names the UID of an IMAP message", () => {
    const location = locateFailedItem(messageObjectPath(["INBOX", "Archive"], 4711));
    expect(location.name).toBe("4711.eml");
    expect(location.itemId).toBe("4711");
    expect(location.folder).toContain("Archive");
  });

  it("keeps a OneDrive path as folder and file name", () => {
    expect(locateFailedItem("Documents/Contracts/offer.docx")).toEqual({
      area: null,
      folder: "Documents/Contracts",
      name: "offer.docx",
      itemId: null,
    });
    expect(locateFailedItem("lonely-id")).toEqual({
      area: null,
      folder: null,
      name: "lonely-id",
      itemId: null,
    });
  });
});

describe("item causes added for warnings", () => {
  it("has catalog entries a classified FailureError keeps", () => {
    expect(catalogEntry("graph.item_incomplete")?.transient).toBe(true);
    expect(
      catalogEntry("imap.message_missing")
        ?.steps({})
        .map((step) => step.id),
    ).toEqual(["wait_automatic", "check_server_limits"]);
  });

  it("classifies the incomplete OneDrive item the engine reports", async () => {
    const { FailureError } = await import("./classify.js");
    const error = new FailureError("Graph returned the item without a name", {
      code: "graph.item_incomplete",
    });
    expect(classifyFailure(error).code).toBe("graph.item_incomplete");
  });
});
