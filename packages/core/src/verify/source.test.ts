import { describe, expect, it } from "vitest";
import type { DriveMeasure, MailMeasure, SourceSignal } from "../manifest.js";
import { sourceEvidence } from "./source.js";

const drive = (rootBytes: number, rootChildren = 0): DriveMeasure => ({
  rootBytes,
  rootChildren,
  at: 1,
});
const mail = (visibleItems: number, hiddenItems = 0): MailMeasure => ({
  visibleItems,
  hiddenItems,
  folders: 9,
  at: 1,
});
const oneDrive = (before: DriveMeasure | null, after: DriveMeasure | null): SourceSignal => ({
  service: "onedrive",
  before,
  after,
});
const mailbox = (
  before: MailMeasure | null,
  after: MailMeasure | null,
  archive: "present" | "none" | "unknown" = "none",
): SourceSignal => ({ service: "mailbox", before, after, archive });

describe("sourceEvidence", () => {
  it("gives nothing without a signal", () => {
    expect(sourceEvidence(undefined)).toBeNull();
    expect(sourceEvidence(null)).toBeNull();
  });

  it("OneDrive: empty when the root holds 0 bytes before and after, empty folders included", () => {
    expect(sourceEvidence(oneDrive(drive(0), drive(0, 2)))).toEqual({
      service: "onedrive",
      verdict: "empty",
      bytes: 0,
    });
  });

  it("OneDrive: content when the root holds bytes before and after (the smaller one)", () => {
    expect(sourceEvidence(oneDrive(drive(20_480, 1), drive(10_240, 1)))).toEqual({
      service: "onedrive",
      verdict: "content",
      bytes: 10_240,
    });
  });

  it("OneDrive: unknown when a measure is missing or the two disagree (a race)", () => {
    for (const signal of [
      oneDrive(drive(0), null),
      oneDrive(null, drive(0)),
      oneDrive(drive(0), drive(5)),
      oneDrive(drive(5), drive(0)),
      oneDrive(drive(Number.NaN), drive(0)),
    ]) {
      expect(sourceEvidence(signal)?.verdict).toBe("unknown");
    }
  });

  it("mailbox: empty with no item in any folder, hidden ones included", () => {
    expect(sourceEvidence(mailbox(mail(0), mail(0)))).toEqual({
      service: "mailbox",
      verdict: "empty",
      items: 0,
    });
  });

  it("mailbox: content with items in visible folders before and after", () => {
    expect(sourceEvidence(mailbox(mail(3), mail(4)))).toEqual({
      service: "mailbox",
      verdict: "content",
      items: 3,
    });
    // An archive does not take content back: the primary mailbox holds it.
    expect(sourceEvidence(mailbox(mail(3), mail(3), "present"))?.verdict).toBe("content");
  });

  it("mailbox: unknown with items in hidden folders only, an archive, a race or a gap", () => {
    for (const signal of [
      mailbox(mail(0, 7), mail(0, 7)),
      mailbox(mail(0), mail(0), "present"),
      mailbox(mail(0), mail(0), "unknown"),
      mailbox(mail(0), mail(1)),
      mailbox(mail(2), mail(0)),
      mailbox(mail(0), null),
      mailbox(null, mail(0)),
    ]) {
      expect(sourceEvidence(signal)?.verdict).toBe("unknown");
    }
  });
});
