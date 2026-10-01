import { describe, expect, it } from "vitest";
import {
  ARCHIVE_MAILBOXES,
  planArchiveUploads,
  segmentsOf,
  senderOf,
  subjectOf,
} from "./archive-seed.js";
import { DEMO_TENANTS, allMailboxes } from "./company.js";
import { planMessages } from "./generate-mail.js";

const NOW = new Date("2026-09-30T01:00:00Z");
const PLANS = planMessages({ seed: 20260101, now: NOW, historyDays: 30, messagesPerMailbox: 40 });

/** A small reader of the mbox this module writes: messages split at `From ` lines, mboxrd unquoted. */
function readMbox(bytes: Buffer): string[] {
  const text = bytes.toString("utf8");
  return text
    .split(/^From \S+ [^\r\n]*\r\n/m)
    .slice(1)
    .map((part) => part.replace(/\r\n\r\n$/, "").replace(/^>(>*From )/gm, "$1"));
}

describe("archive mailboxes", () => {
  it("are one mailbox per demo tenant, each a mailbox the demo already has", () => {
    expect(ARCHIVE_MAILBOXES.map((m) => m.tenantSlug).sort()).toEqual(
      DEMO_TENANTS.map((t) => t.slug).sort(),
    );
    for (const mailbox of ARCHIVE_MAILBOXES) {
      const tenant = DEMO_TENANTS.find((t) => t.slug === mailbox.tenantSlug);
      expect(tenant?.mailboxes.map((m) => m.login)).toContain(mailbox.login);
      expect(allMailboxes().map((m) => m.login)).toContain(mailbox.login);
      expect(mailbox.name).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("place one example legal hold, with a reason that says it is sample data", () => {
    const held = ARCHIVE_MAILBOXES.filter((m) => m.legalHoldReason);
    expect(held).toHaveLength(1);
    expect(held[0]?.legalHoldReason).toContain("Sample data");
  });
});

describe("planArchiveUploads", () => {
  it("makes one mbox per folder holding exactly that mailbox's messages", () => {
    const login = "accounting@example.org";
    const uploads = planArchiveUploads(PLANS, login);
    const own = PLANS.filter((p) => p.mailboxLogin === login);
    expect(uploads.length).toBeGreaterThanOrEqual(2);
    expect(uploads.map((u) => u.fileName)).toEqual(uploads.map((u) => `${u.folder}.mbox`));
    expect(uploads.reduce((sum, u) => sum + u.messages, 0)).toBe(own.length);
    for (const upload of uploads) {
      const expected = own
        .filter((p) => (p.folder ?? "INBOX") === upload.folder)
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .map((p) => p.eml.replace(/\r?\n/g, "\r\n").replace(/(\r\n)+$/, ""));
      expect(readMbox(upload.bytes)).toEqual(expected);
    }
  });

  it("is deterministic and never mixes in another mailbox", () => {
    const a = planArchiveUploads(PLANS, "sales@example.org");
    expect(
      planArchiveUploads(PLANS, "sales@example.org").map((u) => u.bytes.toString("hex")),
    ).toEqual(a.map((u) => u.bytes.toString("hex")));
    const text = a.map((u) => u.bytes.toString("utf8")).join("");
    expect(text).not.toContain("accounting@example.org");
    expect(planArchiveUploads(PLANS, "nobody@example.org")).toEqual([]);
  });

  it("reads the sender and subject of a message", () => {
    const eml =
      "From: Jane Doe <jane.doe@example.com>\r\nSubject: Invoice INV-2026-0001\r\n\r\nbody";
    expect(senderOf(eml)).toBe("jane.doe@example.com");
    expect(subjectOf(eml)).toBe("Invoice INV-2026-0001");
    expect(senderOf("Subject: x\r\n\r\n")).toBe("unknown@example.org");
  });
});

describe("segmentsOf", () => {
  it("cuts a file into segments of the size the server chose, the last one shorter", () => {
    const bytes = Buffer.alloc(25, 1);
    expect(segmentsOf(bytes, 10).map((s) => s.length)).toEqual([10, 10, 5]);
    expect(segmentsOf(bytes, 25).map((s) => s.length)).toEqual([25]);
    expect(segmentsOf(Buffer.concat(segmentsOf(bytes, 7)), 7).length).toBe(4);
  });
});
