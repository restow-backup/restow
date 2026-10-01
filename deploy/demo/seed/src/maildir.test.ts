import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMaildir, writeMaildirMessage } from "./maildir.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "restow-demo-maildir-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureMaildir", () => {
  it("creates cur, new and tmp for the mailbox root", () => {
    ensureMaildir({ root: dir });
    for (const sub of ["cur", "new", "tmp"]) {
      expect(existsSync(join(dir, sub))).toBe(true);
    }
  });

  it("creates a dot-prefixed sibling directory for a folder", () => {
    ensureMaildir({ root: dir, folder: "Sent" });
    for (const sub of ["cur", "new", "tmp"]) {
      expect(existsSync(join(dir, ".Sent", sub))).toBe(true);
    }
  });
});

describe("writeMaildirMessage", () => {
  it("delivers a seen message to cur/ with the :2,S info suffix", () => {
    const path = writeMaildirMessage({ root: dir }, "Subject: x\r\n\r\nbody", {
      date: new Date("2024-01-01T00:00:00Z"),
    });
    expect(dirname(path)).toBe(join(dir, "cur"));
    expect(path.endsWith(":2,S")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("Subject: x\r\n\r\nbody");
  });

  it("stamps the file with the delivery time, which Dovecot reports as INTERNALDATE", () => {
    const date = new Date("2026-09-12T08:30:00Z");
    const path = writeMaildirMessage({ root: dir }, "x", { date });
    expect(statSync(path).mtime.getTime()).toBe(date.getTime());
  });

  it("delivers an unseen message to new/ with no info suffix", () => {
    const path = writeMaildirMessage({ root: dir }, "x", { seen: false });
    expect(path).toContain(join(dir, "new"));
    expect(path.includes(":2,")).toBe(false);
  });

  it("writes into the folder's own cur/, not the mailbox root", () => {
    const path = writeMaildirMessage({ root: dir, folder: "Archive" }, "x");
    expect(path).toContain(join(dir, ".Archive", "cur"));
  });

  it("gives every message a distinct filename, even delivered in the same instant", () => {
    const now = new Date("2024-01-01T00:00:00Z");
    const a = writeMaildirMessage({ root: dir }, "a", { date: now });
    const b = writeMaildirMessage({ root: dir }, "b", { date: now });
    expect(a).not.toBe(b);
    expect(readdirSync(join(dir, "cur"))).toHaveLength(2);
  });

  it("creates the directories on demand: no prior ensureMaildir call needed", () => {
    expect(existsSync(join(dir, "cur"))).toBe(false);
    writeMaildirMessage({ root: dir }, "x");
    expect(existsSync(join(dir, "cur"))).toBe(true);
  });
});
