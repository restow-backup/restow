import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_TENANTS, allMailboxes } from "./company.js";
import {
  type GeneratedMessagePlan,
  generateDemoMail,
  mailboxRoot,
  planMessages,
  planWave,
  waveWindow,
  writeMessages,
} from "./generate-mail.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "restow-demo-mail-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("planMessages", () => {
  it("is fully deterministic for the same seed", () => {
    const a = planMessages({ seed: 42, now: NOW, messagesPerMailbox: 20 });
    const b = planMessages({ seed: 42, now: NOW, messagesPerMailbox: 20 });
    expect(a).toEqual(b);
  });

  it("differs for a different seed", () => {
    const a = planMessages({ seed: 1, now: NOW, messagesPerMailbox: 20 });
    const b = planMessages({ seed: 2, now: NOW, messagesPerMailbox: 20 });
    expect(a).not.toEqual(b);
  });

  it("plans messagesPerMailbox messages for every mailbox", () => {
    const plans = planMessages({ seed: 1, now: NOW, messagesPerMailbox: 15 });
    const mailboxes = allMailboxes();
    expect(plans).toHaveLength(mailboxes.length * 15);
    for (const mailbox of mailboxes) {
      expect(plans.filter((p) => p.mailboxLogin === mailbox.login)).toHaveLength(15);
    }
  });

  it("spreads dates over roughly the last ten years, never in the future", () => {
    const plans = planMessages({ seed: 3, now: NOW, messagesPerMailbox: 80 });
    const tenYearsAgo = new Date(NOW.getTime());
    tenYearsAgo.setUTCFullYear(tenYearsAgo.getUTCFullYear() - 10);
    for (const plan of plans) {
      expect(plan.date.getTime()).toBeLessThanOrEqual(NOW.getTime());
      expect(plan.date.getTime()).toBeGreaterThanOrEqual(tenYearsAgo.getTime());
    }
    const years = new Set(plans.map((p) => p.date.getUTCFullYear()));
    expect(years.size).toBeGreaterThan(1);
  });

  it("uses several folders, including INBOX (null), Sent and Archive", () => {
    const plans = planMessages({ seed: 4, now: NOW, messagesPerMailbox: 100 });
    const folders = new Set(plans.map((p) => p.folder));
    expect(folders).toContain(null);
    expect(folders).toContain("Sent");
    expect(folders).toContain("Archive");
  });

  it("attaches a calendar invite to every meeting message", () => {
    // The .ics content itself is base64-encoded in the message (mime.ts), so
    // it never appears as literal text; the attachment marker does.
    const plans = planMessages({ seed: 5, now: NOW, messagesPerMailbox: 150 });
    const meetings = plans.filter((p) => p.eml.includes('filename="termin.ics"'));
    expect(meetings.length).toBeGreaterThan(0);
    for (const plan of meetings) {
      expect(plan.eml).toContain("Content-Type: multipart/mixed");
      expect(plan.eml).toContain("Content-Type: text/calendar");
    }
  });

  it("attaches at least some PDF and some plain-text files across the corpus", () => {
    const plans = planMessages({ seed: 6, now: NOW, messagesPerMailbox: 150 });
    expect(plans.some((p) => p.eml.includes('filename="rechnung.pdf"'))).toBe(true);
    expect(plans.some((p) => p.eml.includes('filename="notiz.txt"'))).toBe(true);
  });

  it("writes English messages only, for demo visitors from anywhere", () => {
    const plans = planMessages({ seed: 7, now: NOW, messagesPerMailbox: 60 });
    expect(plans.some((p) => p.eml.includes("Dear Sir or Madam") || p.eml.includes("Hi "))).toBe(
      true,
    );
    for (const plan of plans) {
      expect(plan.eml).not.toMatch(/Sehr geehrte|Hallo|Mit freundlichen Grüßen|Rechnung|Einladung/);
    }
  });

  it("contains no real personal or company data, only the fictional example.org/.com/.net domains", () => {
    const plans = planMessages({ seed: 8, now: NOW, messagesPerMailbox: 40 });
    const addresses = [...plans.flatMap((p) => p.eml.match(/[\w.+-]+@[\w.-]+/g) ?? [])];
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) {
      expect(address).toMatch(
        /@(example\.org|example\.com|example\.net|restow-demo\.example\.org)$/,
      );
    }
  });
});

describe("mailboxRoot", () => {
  it("splits the login into <root>/<domain>/<local>", () => {
    expect(mailboxRoot("/var/mail/vhosts", "info@example.org")).toBe(
      join("/var/mail/vhosts", "example.org", "info"),
    );
  });
});

describe("writeMessages and generateDemoMail", () => {
  it("writes every planned message into the right mailbox's Maildir", () => {
    const plans: GeneratedMessagePlan[] = planMessages({
      seed: 9,
      now: NOW,
      messagesPerMailbox: 5,
    });
    writeMessages(dir, plans);
    for (const mailbox of allMailboxes()) {
      const root = mailboxRoot(dir, mailbox.login);
      expect(existsSync(join(root, "cur")) || existsSync(join(root, "new"))).toBe(true);
    }
  });

  it("delivers unseen INBOX messages to new/ and everything else to cur/ with :2,S", () => {
    const plans = planMessages({ seed: 10, now: NOW, messagesPerMailbox: 60 });
    writeMessages(dir, plans);
    const mailbox = allMailboxes()[0];
    if (!mailbox) {
      throw new Error("expected at least one demo mailbox");
    }
    const root = mailboxRoot(dir, mailbox.login);
    const curFiles = readdirSync(join(root, "cur"));
    expect(curFiles.every((name) => name.endsWith(":2,S"))).toBe(true);
    if (existsSync(join(root, "new"))) {
      const newFiles = readdirSync(join(root, "new"));
      expect(newFiles.every((name) => !name.includes(":2,"))).toBe(true);
    }
  });

  it("generateDemoMail plans and writes in one call and reports counts", () => {
    const summary = generateDemoMail(dir, { seed: 11, now: NOW, messagesPerMailbox: 10 });
    expect(summary.mailboxes).toBe(allMailboxes().length);
    expect(summary.messages).toBe(allMailboxes().length * 10);
  });

  it("writes readable, well-formed content for at least one message", () => {
    // Enough messages that, whichever folders seed 12 happens to pick, at
    // least one lands in INBOX and one in each of Sent and Archive.
    const plans = planMessages({ seed: 12, now: NOW, messagesPerMailbox: 30 });
    writeMessages(dir, plans);
    const mailbox = allMailboxes()[0];
    if (!mailbox) {
      throw new Error("expected at least one demo mailbox");
    }
    const root = mailboxRoot(dir, mailbox.login);
    const messageDirs = [root, join(root, ".Sent"), join(root, ".Archive")].flatMap((base) => [
      join(base, "cur"),
      join(base, "new"),
    ]);
    const files = messageDirs
      .filter((messageDir) => existsSync(messageDir))
      .flatMap((messageDir) => readdirSync(messageDir).map((name) => join(messageDir, name)));
    expect(files.length).toBeGreaterThan(0);
    const content = readFileSync(files[0] ?? "", "utf8");
    expect(content).toMatch(/^From: .*<.*@.*>/);
    expect(content).toContain("Subject:");
  });

  it("covers two demo tenants across the generated mailboxes (company.ts)", () => {
    expect(DEMO_TENANTS.length).toBe(2);
    expect(allMailboxes().length).toBeGreaterThanOrEqual(2);
  });
});

describe("history waves", () => {
  const FROM = new Date("2026-09-22T01:30:00.000Z"); // a Tuesday
  const TO = new Date("2026-09-23T01:30:00.000Z");

  it("keeps the base corpus older than the history", () => {
    const plans = planMessages({ seed: 1, now: NOW, messagesPerMailbox: 30, historyDays: 30 });
    const cutoff = NOW.getTime() - 30 * 24 * 60 * 60 * 1000;
    expect(plans.every((plan) => plan.date.getTime() <= cutoff)).toBe(true);
  });

  it("plans a few messages per mailbox on a working day, within office hours between the backups", () => {
    const plans = planWave({ seed: 1, wave: 3, from: FROM, to: TO });
    for (const mailbox of allMailboxes()) {
      const count = plans.filter((plan) => plan.mailboxLogin === mailbox.login).length;
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(6);
    }
    for (const plan of plans) {
      expect(plan.date.getTime()).toBeGreaterThan(FROM.getTime());
      expect(plan.date.getTime()).toBeLessThan(TO.getTime());
      expect(plan.date.getUTCHours()).toBeGreaterThanOrEqual(6);
      expect(plan.date.getUTCHours()).toBeLessThan(18);
    }
  });

  it("plans at most one message per mailbox at the weekend", () => {
    const saturday = new Date("2026-09-26T01:30:00.000Z");
    const plans = planWave({
      seed: 1,
      wave: 7,
      from: saturday,
      to: new Date(saturday.getTime() + 86_400_000),
    });
    for (const mailbox of allMailboxes()) {
      expect(
        plans.filter((plan) => plan.mailboxLogin === mailbox.login).length,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic and differs from wave to wave", () => {
    const a = planWave({ seed: 1, wave: 3, from: FROM, to: TO });
    expect(planWave({ seed: 1, wave: 3, from: FROM, to: TO })).toEqual(a);
    expect(planWave({ seed: 1, wave: 4, from: FROM, to: TO })).not.toEqual(a);
  });

  it("falls back to the whole gap when office hours lie outside it", () => {
    const window = waveWindow(
      new Date("2026-09-22T19:00:00.000Z"),
      new Date("2026-09-22T23:00:00.000Z"),
    );
    expect(window.start).toBeGreaterThan(new Date("2026-09-22T19:00:00.000Z").getTime());
    expect(window.end).toBeLessThan(new Date("2026-09-22T23:00:00.000Z").getTime());
  });
});
