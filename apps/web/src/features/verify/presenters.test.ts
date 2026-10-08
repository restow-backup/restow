import deVerify from "@restow/i18n/resources/de/verify.json";
import enVerify from "@restow/i18n/resources/en/verify.json";
import { describe, expect, it } from "vitest";

import type { Failure } from "@/features/failures/api";
import type {
  EndpointReadinessRow,
  ObjectReadiness,
  Reason,
  RunVerifyResult,
} from "@/features/verify/api";
import {
  SNAPSHOT_VERIFICATION_TONE,
  STATE_BADGE,
  findingBlocks,
  gcMessage,
  isWaitingForFirstBackup,
  needsAttention,
  objectAddress,
  objectName,
  orderReasons,
  readinessRows,
  reasonMessage,
  rowName,
  rowRating,
  runResultMessage,
  snapshotVerificationView,
  sortByUrgency,
  sortRowsByUrgency,
  startErrorMessage,
  stateBadgeView,
  targetLabel,
  targetStatusKey,
  unverifiedRunMessage,
} from "@/features/verify/presenters";
import { ApiError } from "@/lib/api";

function item(name: string, state: ObjectReadiness["state"], overdue = false): ObjectReadiness {
  return {
    object: {
      id: name,
      kind: "mailbox",
      displayName: name,
      externalId: `${name}@example.org`,
      status: "active",
      email: null,
      upn: null,
    },
    state,
    readiness: state === "green" || state === "yellow" || state === "red" ? state : null,
    checkedAt: null,
    overdue,
    latestSnapshotAt: null,
    report: null,
    running: null,
    latestSnapshotId: null,
    previousCheck: null,
  };
}

/** Resolve a dotted key in a translation bundle. */
function lookup(bundle: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      bundle,
    );
}

describe("sortByUrgency", () => {
  it("puts what cannot be restored first and healthy objects last", () => {
    const sorted = sortByUrgency([
      item("Zoe", "green"),
      item("Bert", "yellow"),
      item("Anna", "green", true),
      item("Carl", "no_backup"),
      item("Dora", "unverified"),
      item("Emil", "red"),
    ]);
    expect(sorted.map((entry) => entry.object.displayName)).toEqual([
      "Emil",
      "Dora",
      "Carl",
      "Bert",
      "Anna",
      "Zoe",
    ]);
  });
});

function machine(
  hostname: string,
  state: EndpointReadinessRow["state"],
  over: Partial<EndpointReadinessRow> = {},
): EndpointReadinessRow {
  return {
    id: `id-${hostname}`,
    hostname,
    displayName: null,
    profile: "server",
    os: "linux",
    state,
    readiness: state === "green" || state === "yellow" || state === "red" ? state : null,
    checkedAt: null,
    overdue: false,
    latestBackupAt: null,
    latestSnapshotId: null,
    ...over,
  };
}

describe("readinessRows", () => {
  it("lists the mail objects and the machines as one set the summary counts", () => {
    const rows = readinessRows(
      [item("Ada", "green"), item("Bob", "red")],
      [machine("web-01", "green")],
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.type)).toEqual(["object", "object", "endpoint"]);
    expect(rows.map((row) => row.id)).toEqual(["Ada", "Bob", "id-web-01"]);
  });

  it("lists the VMs and containers after the machines, rated and named like them", () => {
    const guest = {
      id: "g-1",
      vmid: 101,
      kind: "vm" as const,
      name: null,
      node: "pve1",
      state: "red" as const,
      readiness: "red" as const,
      checkedAt: null,
      overdue: false,
      latestBackupAt: null,
      latestSnapshotId: null,
      inJob: true,
    };
    const rows = readinessRows([item("Ada", "green")], [], [guest]);
    expect(rows.map((row) => row.type)).toEqual(["object", "guest"]);
    const [, row] = rows as [
      ReturnType<typeof readinessRows>[number],
      ReturnType<typeof readinessRows>[number],
    ];
    expect(rowRating(row)).toMatchObject({ state: "red", overdue: false });
    expect(rowName(row)).toBe("VM 101");
    expect(sortRowsByUrgency(rows).map(rowName)).toEqual(["VM 101", "Ada"]);
  });

  it("works for a server that sends no machines", () => {
    expect(readinessRows([item("Ada", "green")])).toHaveLength(1);
    expect(readinessRows([], undefined)).toEqual([]);
  });

  it("rates and names a machine the way it does an object", () => {
    const [object, endpoint] = readinessRows(
      [item("Ada", "yellow", true)],
      [machine("web-01", "no_backup", { displayName: "  Web front  ", overdue: true })],
    ) as [ReturnType<typeof readinessRows>[number], ReturnType<typeof readinessRows>[number]];
    expect(rowRating(object)).toMatchObject({ state: "yellow", overdue: true });
    expect(rowRating(endpoint)).toMatchObject({ state: "no_backup", overdue: true });
    expect(rowName(object)).toBe("Ada");
    expect(rowName(endpoint)).toBe("Web front");
    // The attention rules apply to machines unchanged.
    expect(needsAttention(rowRating(endpoint))).toBe(true);
    expect(isWaitingForFirstBackup(rowRating(endpoint))).toBe(false);
  });
});

describe("sortRowsByUrgency", () => {
  it("orders mailboxes and machines together, worst first", () => {
    const sorted = sortRowsByUrgency(
      readinessRows(
        [item("Zoe", "green"), item("Dora", "unverified"), item("Anna", "green", true)],
        [
          machine("m-red", "red"),
          machine("m-green", "green"),
          machine("m-none", "no_backup", { overdue: true }),
          machine("m-yellow", "yellow"),
        ],
      ),
    );
    expect(sorted.map(rowName)).toEqual([
      "m-red",
      "Dora",
      "m-none",
      "m-yellow",
      "Anna",
      "m-green",
      "Zoe",
    ]);
  });

  it("does not touch the list it is given", () => {
    const rows = readinessRows([item("B", "green"), item("A", "red")]);
    sortRowsByUrgency(rows);
    expect(rows.map(rowName)).toEqual(["B", "A"]);
  });
});

describe("needsAttention", () => {
  it("includes overdue green objects", () => {
    expect(needsAttention(item("a", "green"))).toBe(false);
    expect(needsAttention(item("a", "green", true))).toBe(true);
    expect(needsAttention(item("a", "unverified"))).toBe(true);
  });

  it("does not count a fresh no_backup object, only an overdue one", () => {
    expect(needsAttention(item("a", "no_backup"))).toBe(false);
    expect(needsAttention(item("a", "no_backup", true))).toBe(true);
  });
});

describe("isWaitingForFirstBackup", () => {
  it("is the exact complement of needsAttention for no_backup objects", () => {
    expect(isWaitingForFirstBackup(item("a", "no_backup"))).toBe(true);
    expect(isWaitingForFirstBackup(item("a", "no_backup", true))).toBe(false);
    expect(isWaitingForFirstBackup(item("a", "green"))).toBe(false);
    expect(isWaitingForFirstBackup(item("a", "unverified"))).toBe(false);
  });
});

describe("stateBadgeView", () => {
  it("gives a fresh no_backup object a warning tone and a distinct label", () => {
    expect(stateBadgeView(item("a", "no_backup"))).toEqual({
      tone: "warning",
      key: "state.waitingForFirstBackup",
    });
  });

  it("keeps the red tone once no_backup is overdue", () => {
    expect(stateBadgeView(item("a", "no_backup", true))).toEqual({
      tone: "destructive",
      key: "state.no_backup",
    });
  });

  it("falls back to the static map for every other state", () => {
    expect(stateBadgeView(item("a", "green"))).toEqual({ tone: "success", key: "state.green" });
    expect(stateBadgeView(item("a", "red"))).toEqual({ tone: "destructive", key: "state.red" });
  });
});

describe("objectName and objectAddress", () => {
  const mailbox = (over: Partial<ObjectReadiness["object"]> = {}) => ({
    id: "o1",
    kind: "mailbox" as const,
    displayName: null,
    externalId: "11111111-1111-4111-8111-111111111111",
    status: "active" as const,
    email: null,
    upn: null,
    ...over,
  });

  it("prefers the display name, then the address, over the opaque external id", () => {
    expect(objectName(mailbox({ displayName: "Ada Example" }))).toBe("Ada Example");
    expect(objectName(mailbox({ email: "ada@contoso.test" }))).toBe("ada@contoso.test");
    // Neither known: the last resort is the id, which the table never shows as the label.
    expect(objectName(mailbox())).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("shows the address as a subtitle only when it adds information", () => {
    expect(objectAddress(mailbox({ displayName: "Ada Example", email: "ada@contoso.test" }))).toBe(
      "ada@contoso.test",
    );
    // The name already is the address: nothing more to say.
    expect(objectAddress(mailbox({ email: "ada@contoso.test" }))).toBeNull();
    // No linked user at all: never invented from the opaque external id.
    expect(objectAddress(mailbox())).toBeNull();
  });

  it("treats the IMAP login as the address, never the opaque id of the other kinds", () => {
    const imap = mailbox({
      kind: "imap",
      displayName: "Backup mailbox",
      externalId: "svc-backup@example.test",
    });
    expect(objectAddress(imap)).toBe("svc-backup@example.test");
  });
});

describe("STATE_BADGE", () => {
  it("never shows an unproven backup as fine", () => {
    expect(STATE_BADGE.unverified).toBe("destructive");
    expect(STATE_BADGE.no_backup).toBe("destructive");
    expect(STATE_BADGE.green).toBe("success");
  });
});

describe("snapshot verification", () => {
  const date = (iso: string) => `on ${iso}`;
  const states = ["green", "yellow", "red", "unverified"] as const;

  it("never renders a backup no check has read back in a success tone", () => {
    expect(SNAPSHOT_VERIFICATION_TONE.unverified).toBe("warning");
    const view = snapshotVerificationView(
      { state: "unverified", checkedAt: null, reportId: null },
      date,
    );
    expect(view.tone).not.toBe("success");
    expect(view.tone).toBe("warning");
    expect(view.label).toEqual({ key: "snapshot.state.unverified" });
    expect(view.hint).toEqual({ key: "snapshot.hint.unverified" });
  });

  it("shows only a passed check as a success, with the check date as the hint", () => {
    const at = "2026-09-22T03:00:00.000Z";
    expect(
      snapshotVerificationView({ state: "green", checkedAt: at, reportId: "r1" }, date),
    ).toEqual({
      tone: "success",
      label: { key: "snapshot.state.green" },
      hint: { key: "snapshot.hint.checked", values: { date: `on ${at}` } },
    });
    expect(SNAPSHOT_VERIFICATION_TONE.yellow).toBe("warning");
    expect(SNAPSHOT_VERIFICATION_TONE.red).toBe("destructive");
    const successes = states.filter((state) => SNAPSHOT_VERIFICATION_TONE[state] === "success");
    expect(successes).toEqual(["green"]);
  });

  it("has a label and a hint for every state in both languages", () => {
    for (const state of states) {
      const view = snapshotVerificationView(
        {
          state,
          checkedAt: state === "unverified" ? null : "2026-09-22T03:00:00Z",
          reportId: null,
        },
        date,
      );
      for (const bundle of [enVerify, deVerify]) {
        expect(typeof lookup(bundle, view.label.key)).toBe("string");
        expect(typeof lookup(bundle, view.hint.key)).toBe("string");
      }
    }
  });

  it("summarises a run for the unverified backups", () => {
    expect(unverifiedRunMessage({ queued: [], skipped: [] })).toEqual({
      key: "toast.nothingUnverified",
    });
    expect(
      unverifiedRunMessage({
        queued: [{ jobId: "j", protectedObjectId: "o", displayName: null, kind: "verify" }],
        skipped: [],
      }),
    ).toEqual({ key: "toast.unverifiedQueued", values: { count: 1 } });
  });
});

describe("reasonMessage", () => {
  it("maps stored findings to translation keys with their parameters", () => {
    expect(
      reasonMessage({ code: "snapshot_outdated", severity: "red", count: null, ageHours: 200 }),
    ).toEqual({
      key: "reason.snapshot_outdated",
      values: { count: 0, hours: 200, days: 8 },
    });
    expect(
      reasonMessage({ code: "items_missing", severity: "red", count: 3, ageHours: null }),
    ).toMatchObject({
      key: "reason.items_missing",
      values: { count: 3 },
    });
  });

  it("falls back to a generic text for codes from a newer worker", () => {
    expect(
      reasonMessage({ code: "quantum_drift", severity: "yellow", count: null, ageHours: null }),
    ).toEqual({
      key: "reason.unknown",
      values: { code: "quantum_drift" },
    });
  });

  it("has a translation for every known finding in both languages", () => {
    const codes = [
      "no_snapshot",
      "manifest_unreadable",
      "items_missing",
      "items_unreadable",
      "items_mismatched",
      "storage_corrupt",
      "test_restore_failed",
      "snapshot_outdated",
      "snapshot_stale",
      "nothing_to_verify",
      "test_restore_unconfirmed",
    ];
    for (const code of codes) {
      const { key } = reasonMessage({ code, severity: "red", count: 1, ageHours: 1 });
      expect(typeof lookup(enVerify, key)).toBe("string");
      expect(typeof lookup(deVerify, key)).toBe("string");
    }
  });
});

const cause: Failure = {
  code: "verify.hash_mismatch",
  category: "verify",
  transient: false,
  retryable: true,
  params: { count: 3 },
  technical: {},
  occurredAt: "2026-09-20T03:00:00.000Z",
  step: null,
  retry: null,
  steps: [{ id: "run_backup_again", target: "jobs" }],
  docsUrl: "https://docs.example.test/troubleshooting",
};

function reason(
  code: string,
  severity: Reason["severity"],
  failure: Failure | null = cause,
): Reason {
  return { code, severity, count: null, ageHours: null, failure };
}

describe("orderReasons", () => {
  it("puts red findings before yellow ones and keeps the order within a colour", () => {
    const ordered = orderReasons([
      reason("snapshot_stale", "yellow"),
      reason("items_mismatched", "red"),
      reason("nothing_to_verify", "yellow"),
      reason("storage_corrupt", "red"),
    ]);
    expect(ordered.map((entry) => entry.code)).toEqual([
      "items_mismatched",
      "storage_corrupt",
      "snapshot_stale",
      "nothing_to_verify",
    ]);
  });

  it("does not change the list it is given", () => {
    const input = [reason("a", "yellow"), reason("b", "red")];
    orderReasons(input);
    expect(input.map((entry) => entry.code)).toEqual(["a", "b"]);
  });
});

describe("findingBlocks", () => {
  it("explains a finding the server explained and keeps the plain line for the others", () => {
    const blocks = findingBlocks([
      reason("snapshot_stale", "yellow", null),
      reason("items_mismatched", "red"),
      reason("quantum_drift", "red", null),
      reason("nothing_to_verify", "yellow", null),
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(["explained", "plain"]);
    const [, plain] = blocks;
    expect(plain?.kind === "plain" ? plain.reasons.map((entry) => entry.code) : []).toEqual([
      "quantum_drift",
      "snapshot_stale",
      "nothing_to_verify",
    ]);
  });

  it("returns one plain block, in the old order within a colour, when nothing was explained", () => {
    const blocks = findingBlocks([reason("a", "red", null), reason("b", "red", null)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "plain" });
  });

  it("tolerates a response from a server that does not send causes yet", () => {
    const old = { code: "no_snapshot", severity: "red", count: null, ageHours: null } as Reason;
    expect(findingBlocks([old])).toEqual([{ kind: "plain", reasons: [old] }]);
  });

  it("returns nothing for no findings", () => {
    expect(findingBlocks([])).toEqual([]);
  });
});

describe("storage labels", () => {
  it("names targets and falls back for unknown statuses", () => {
    expect(targetLabel(0)).toEqual({ key: "storage.target.primary" });
    expect(targetLabel(2)).toEqual({ key: "storage.target.copy", values: { index: 2 } });
    expect(targetStatusKey("hash_mismatch")).toBe("storage.targetStatus.hash_mismatch");
    expect(targetStatusKey("cosmic_ray")).toBe("storage.targetStatus.other");
  });
});

describe("gcMessage", () => {
  const bytes = (value: number) => `${value} B`;

  it("stays quiet for sample runs and reports what a full run did", () => {
    expect(gcMessage({ status: "skipped", reason: "sample_run" }, bytes)).toBeNull();
    expect(gcMessage({ status: "skipped", reason: "backup_running" }, bytes)).toEqual({
      key: "storage.gc.skipped.backup_running",
    });
    const completed = {
      status: "completed" as const,
      packsRewritten: 1,
      packsRemoved: 0,
      chunksDropped: 4,
      bytesReclaimed: 2048,
      conflicts: 0,
      interruptedBy: null,
      skipped: 0,
    };
    expect(gcMessage(completed, bytes)).toEqual({
      key: "storage.gc.reclaimed",
      values: { bytes: "2048 B" },
    });
    expect(gcMessage({ ...completed, interruptedBy: "backup_running" }, bytes)).toEqual({
      key: "storage.gc.interrupted",
    });
    expect(gcMessage({ ...completed, bytesReclaimed: 0 }, bytes)).toEqual({
      key: "storage.gc.clean",
    });
  });

  it("names the kind of job that postponed the cleanup, in both languages", () => {
    for (const reason of ["backup_running", "restore_running", "verify_running"]) {
      const message = gcMessage({ status: "skipped", reason }, bytes);
      expect(message).toEqual({ key: `storage.gc.skipped.${reason}` });
      expect(typeof lookup(enVerify, message?.key ?? "")).toBe("string");
      expect(typeof lookup(deVerify, message?.key ?? "")).toBe("string");
    }
    expect(gcMessage({ status: "skipped", reason: "not_known_yet" }, bytes)).toEqual({
      key: "storage.gc.skipped.other",
    });
  });
});

describe("start messages", () => {
  it("explains known conflicts and falls back to the common error texts", () => {
    const conflict = new ApiError(
      409,
      { type: "about:blank", title: "Check not possible", status: 409, reason: "already_queued" },
      "conflict",
    );
    expect(startErrorMessage(conflict)).toEqual({ key: "toast.alreadyQueued" });
    expect(startErrorMessage(new ApiError(500, null, "boom"))).toEqual({
      key: "common:errors.server",
    });
  });

  it("summarises a check-all run", () => {
    const queued: RunVerifyResult["queued"] = [
      { jobId: "j1", protectedObjectId: "o1", displayName: null, kind: "verify" },
    ];
    const skipped: RunVerifyResult["skipped"] = [
      { protectedObjectId: "o2", displayName: null, reason: "no_backup" },
    ];
    expect(runResultMessage({ queued: [], skipped })).toEqual({ key: "toast.nothingQueued" });
    expect(runResultMessage({ queued, skipped: [] })).toEqual({
      key: "toast.queued",
      values: { count: 1 },
    });
    expect(runResultMessage({ queued, skipped })).toEqual({
      key: "toast.queuedWithSkipped",
      values: { count: 1, skipped: 1 },
    });
  });
});
