import { describe, expect, it } from "vitest";

import {
  captureKeysOf,
  captureKindsOfScope,
  captureReduction,
  DEFAULT_CAPTURE_WAYS,
  effectiveCaptureWays,
  forwardingChosen,
  keysWithoutWay,
  needsJournal,
  sameCaptureWays,
  serverCaptureKeys,
  withWay,
} from "./capture-ways.js";
import { mailJob } from "./fixtures.js";
import { draftOfJob, newJobDraft, updateInputOf } from "./form.js";

describe("capture ways of a mail job", () => {
  it("groups the kinds by the settings they use: IMAP at Microsoft shares the IMAP ways", () => {
    expect(captureKeysOf(["google", "imap_microsoft", "m365", "imap"])).toEqual([
      "m365",
      "imap",
      "google",
    ]);
    expect(captureKeysOf(["imap_microsoft"])).toEqual(["imap"]);
    expect(captureKeysOf([])).toEqual([]);
  });

  it("fills the defaults in: Graph for Microsoft 365, IMAP sync for IMAP and Google", () => {
    expect(effectiveCaptureWays({ imap: { sync: false, forward: true } })).toEqual({
      ...DEFAULT_CAPTURE_WAYS,
      imap: { sync: false, forward: true },
    });
    expect(sameCaptureWays(undefined, DEFAULT_CAPTURE_WAYS)).toBe(true);
    expect(sameCaptureWays({ m365: { graph: true, journal: true } }, undefined)).toBe(false);
  });

  it("names only the kinds the job covers that have no way at all", () => {
    const none = withWay(DEFAULT_CAPTURE_WAYS, "imap", "sync", false);
    expect(keysWithoutWay(none, ["m365", "google"])).toEqual([]);
    expect(keysWithoutWay(none, ["imap_microsoft", "m365"])).toEqual(["imap"]);
    expect(keysWithoutWay(withWay(none, "imap", "forward", true), ["imap"])).toEqual([]);
  });

  it("takes the kinds of the chosen objects, or of the tenant for a job that covers all", () => {
    const selected = [{ captureKind: "imap" as const }, { captureKind: null }, {}];
    expect(captureKindsOfScope("selected", selected, ["m365"])).toEqual(["imap"]);
    expect(captureKindsOfScope("all", selected, ["m365", "google"])).toEqual(["m365", "google"]);
    expect(captureKindsOfScope("all", selected, undefined)).toEqual([]);
  });

  it("needs the journal address only for Microsoft 365 mailboxes with journaling chosen", () => {
    const journal = withWay(DEFAULT_CAPTURE_WAYS, "m365", "journal", true);
    expect(needsJournal(journal, ["m365"])).toBe(true);
    expect(needsJournal(journal, ["imap", "google"])).toBe(false);
    expect(needsJournal(DEFAULT_CAPTURE_WAYS, ["m365"])).toBe(false);
    expect(forwardingChosen(withWay(journal, "google", "forward", true), ["google"])).toBe(true);
    expect(forwardingChosen(withWay(journal, "google", "forward", true), ["imap"])).toBe(false);
  });

  it("puts the server's refusal at a card the editor shows, else nowhere", () => {
    expect(serverCaptureKeys(["archiveCapture", "google"], ["google", "m365"])).toEqual(["google"]);
    expect(serverCaptureKeys(["archiveCapture", "google"], ["m365"])).toEqual([]);
  });
});

describe("capture ways in the job draft", () => {
  it("starts a new mail job from the defaults", () => {
    expect(newJobDraft("mail", undefined).archiveCapture).toEqual(DEFAULT_CAPTURE_WAYS);
  });

  it("sends the ways only when they changed and the job archives", () => {
    const job = mailJob({
      archive: true,
      archiveCapture: { ...DEFAULT_CAPTURE_WAYS, m365: { graph: true, journal: true } },
    });
    const draft = draftOfJob(job, [], undefined);
    expect(updateInputOf(job, draft)).toBeNull();
    const changed = {
      ...draft,
      archiveCapture: withWay(draft.archiveCapture, "m365", "graph", false),
    };
    expect(updateInputOf(job, changed)).toEqual({
      archiveCapture: { ...DEFAULT_CAPTURE_WAYS, m365: { graph: false, journal: true } },
    });
    // A job that stops archiving keeps its ways as they are.
    expect(updateInputOf(job, { ...changed, archive: false })).toEqual({ archive: false });
  });
});

describe("what a save stops capturing", () => {
  const saved = {
    archive: true,
    archiveCapture: withWay(DEFAULT_CAPTURE_WAYS, "imap", "forward", true),
  };

  it("names archiving switched off, and nothing for a job that did not archive", () => {
    const draft = { archive: false, archiveCapture: DEFAULT_CAPTURE_WAYS };
    expect(captureReduction(saved, draft, ["imap"])).toEqual({ archiveOff: true, ways: [] });
    expect(captureReduction({ ...saved, archive: false }, draft, ["imap"])).toBeNull();
  });

  it("names each way switched off for a kind the job covers, not ways added", () => {
    const draft = {
      archive: true,
      archiveCapture: withWay(
        withWay(saved.archiveCapture, "imap", "sync", false),
        "m365",
        "journal",
        true,
      ),
    };
    expect(captureReduction(saved, draft, ["imap", "m365"])).toEqual({
      archiveOff: false,
      ways: [{ key: "imap", field: "sync" }],
    });
    // A kind the job does not cover is no reduction.
    expect(captureReduction(saved, draft, ["m365"])).toBeNull();
  });
});
