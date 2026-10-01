import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createEmlZip } from "./eml-zip.js";
import { ExportIntegrityError, JobAbortedError } from "./errors.js";
import {
  checkSha256Sums,
  collect,
  parseManifest,
  sampleEml,
  sha256Hex,
  testMessage,
  unzip,
} from "./testing.js";
import type { ExportEntry, ExportMessage } from "./types.js";

async function run(messages: ExportMessage[], options: Parameters<typeof createEmlZip>[1] = {}) {
  const { stream, completed } = createEmlZip(messages, options);
  const [archive, summary] = await Promise.all([collect(stream), completed]);
  return { archive, summary, entries: await unzip(archive) };
}

describe("createEmlZip", () => {
  it("writes folders, messages, MANIFEST.csv and SHA256SUMS", async () => {
    const one = sampleEml({ subject: "Quarterly figures", messageId: "<a@example.test>" });
    const two = sampleEml({
      subject: "Re: plan / 2026",
      body: "Second",
      messageId: "<b@example.test>",
    });
    const three = sampleEml({ subject: "Root level" });
    const { archive, summary, entries } = await run([
      testMessage(one, {
        folder: ["Inbox"],
        subject: "Quarterly figures",
        messageId: "<a@example.test>",
      }),
      testMessage(two, {
        folder: ["Inbox", "Projects"],
        subject: "Re: plan / 2026",
        messageId: "<b@example.test>",
        date: new Date(Date.UTC(2025, 0, 2, 3, 4, 5)),
      }),
      testMessage(three, { folder: [], subject: "Root level" }),
    ]);

    expect(archive.subarray(0, 2).toString()).toBe("PK");
    expect(entries.map((entry) => entry.name)).toEqual([
      "Inbox/",
      "Inbox/2024-03-05 Quarterly figures.eml",
      "Inbox/Projects/",
      "Inbox/Projects/2025-01-02 Re_ plan _ 2026.eml",
      "2024-03-05 Root level.eml",
      "MANIFEST.csv",
      "SHA256SUMS",
    ]);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get("Inbox/2024-03-05 Quarterly figures.eml")?.data.toString()).toBe(one);
    expect(byName.get("Inbox/Projects/2025-01-02 Re_ plan _ 2026.eml")?.data.toString()).toBe(two);

    expect(summary.messages).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.bytes).toBe(one.length + two.length + three.length);
    expect(summary.entries.map((entry) => entry.status)).toEqual(["added", "added", "added"]);

    // MANIFEST.csv: recompute the hashes from the extracted entries.
    const manifest = parseManifest(
      (byName.get("MANIFEST.csv") as { data: Buffer }).data.toString(),
    );
    expect(manifest).toHaveLength(3);
    for (const row of manifest) {
      const entry = byName.get(row.entry);
      expect(entry, row.entry).toBeDefined();
      expect(row.sha256).toBe(sha256Hex((entry as { data: Buffer }).data));
      expect(Number(row.size)).toBe((entry as { data: Buffer }).data.length);
      expect(row.status).toBe("added");
    }
    expect(manifest[0]).toMatchObject({
      message_id: "<a@example.test>",
      date: "2024-03-05T10:20:30.000Z",
      from: "Anna Example <anna@example.test>",
      to: "bob@example.test",
      subject: "Quarterly figures",
    });

    // SHA256SUMS: exact `sha256sum -c` format, covers every message and the manifest.
    const sums = (byName.get("SHA256SUMS") as { data: Buffer }).data.toString();
    const checked = checkSha256Sums(sums, entries);
    expect(checked).toEqual([
      "Inbox/2024-03-05 Quarterly figures.eml",
      "Inbox/Projects/2025-01-02 Re_ plan _ 2026.eml",
      "2024-03-05 Root level.eml",
      "MANIFEST.csv",
    ]);
  });

  it("keeps empty folders and marks names as UTF-8", async () => {
    const { entries } = await run(
      [testMessage(sampleEml(), { folder: ["Posteingang"], subject: "Grüße aus Köln 🎉" })],
      { extraFolders: [["Archiv", "2019"], ["Gesendet"], ["Posteingang"]] },
    );
    const names = entries.map((entry) => entry.name);
    expect(names.slice(0, 4)).toEqual(["Archiv/", "Archiv/2019/", "Gesendet/", "Posteingang/"]);
    expect(names).toContain("Posteingang/2024-03-05 Grüße aus Köln 🎉.eml");
    const emptyFolders = entries.filter((entry) => entry.isDirectory);
    expect(emptyFolders.map((entry) => entry.name)).toEqual([
      "Archiv/",
      "Archiv/2019/",
      "Gesendet/",
      "Posteingang/",
    ]);
    for (const entry of entries.filter((e) => !/^[\x20-\x7e]*$/.test(e.name))) {
      expect(entry.utf8Name).toBe(true);
    }
  });

  it("gives colliding names a numeric suffix, case-insensitively, and keeps distinct folders apart", async () => {
    const { entries } = await run([
      testMessage(sampleEml({ body: "1" }), { subject: "Same" }),
      testMessage(sampleEml({ body: "2" }), { subject: "same" }),
      testMessage(sampleEml({ body: "3" }), { subject: "SAME" }),
      testMessage(sampleEml({ body: "4" }), { folder: ["inbox"], subject: "Same" }),
      testMessage(sampleEml({ body: "5" }), { folder: ["a:b"], subject: "x" }),
      testMessage(sampleEml({ body: "6" }), { folder: ["a_b"], subject: "x" }),
    ]);
    const files = entries
      .filter((e) => !e.isDirectory && e.name.endsWith(".eml"))
      .map((e) => e.name);
    expect(files).toEqual([
      "Inbox/2024-03-05 Same.eml",
      "Inbox/2024-03-05 same (2).eml",
      "Inbox/2024-03-05 SAME (3).eml",
      "inbox (2)/2024-03-05 Same.eml",
      "a_b/2024-03-05 x.eml",
      "a_b (2)/2024-03-05 x.eml",
    ]);
  });

  it("does not let a folder shadow the manifest files", async () => {
    const { entries } = await run([
      testMessage(sampleEml(), { folder: ["MANIFEST.csv"], subject: "x" }),
      testMessage(sampleEml(), { folder: ["sha256sums"], subject: "y" }),
    ]);
    const names = entries.map((entry) => entry.name);
    expect(names).toContain("MANIFEST.csv (2)/");
    expect(names).toContain("sha256sums (2)/");
    expect(names.filter((name) => name === "MANIFEST.csv")).toHaveLength(1);
  });

  it("is deterministic: the same messages give the same names and the same manifest hashes", async () => {
    const make = () => [
      testMessage(sampleEml({ subject: "A" }), { subject: "A" }),
      testMessage(sampleEml({ subject: "A" }), { subject: "A" }),
    ];
    const now = () => new Date(Date.UTC(2026, 8, 30, 12, 0, 0));
    const first = await run(make(), { now });
    const second = await run(make(), { now });
    expect(first.entries.map((entry) => entry.name)).toEqual(
      second.entries.map((entry) => entry.name),
    );
    expect(sha256Hex(first.archive)).toBe(sha256Hex(second.archive));
  });

  it("streams messages that arrive in many chunks from an async source", async () => {
    const big = Buffer.from(sampleEml({ body: "x".repeat(300_000) }));
    async function* source(): AsyncGenerator<ExportMessage> {
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        yield testMessage(big, { chunkSize: 4096, subject: `Message ${i}` });
      }
    }
    const { stream, completed } = createEmlZip(source());
    const [archive, summary] = await Promise.all([collect(stream), completed]);
    const entries = await unzip(archive);
    expect(summary.messages).toBe(5);
    expect(entries.filter((e) => e.name.endsWith(".eml"))).toHaveLength(5);
    for (const entry of entries.filter((e) => e.name.endsWith(".eml"))) {
      expect(entry.data.equals(big)).toBe(true);
    }
  });

  it("stores empty messages and clamps unusable dates", async () => {
    const { entries, summary } = await run([
      testMessage("", { subject: "Empty", date: null }),
      testMessage(sampleEml(), { subject: "Ancient", date: new Date(Date.UTC(1969, 0, 1)) }),
    ]);
    expect(summary.messages).toBe(2);
    const empty = entries.find((e) => e.name === "Inbox/undated Empty.eml");
    expect(empty?.data.length).toBe(0);
    const ancient = entries.find((e) => e.name === "Inbox/1969-01-01 Ancient.eml");
    expect(ancient?.modified.getFullYear()).toBe(1980);
  });

  describe("failures", () => {
    it("aborts the whole archive when the bytes do not match the recorded hash", async () => {
      const seen: ExportEntry[] = [];
      const { stream, completed } = createEmlZip(
        [
          testMessage(sampleEml({ subject: "fine" })),
          testMessage(sampleEml({ subject: "corrupt" }), { sha256: "0".repeat(64) }),
          testMessage(sampleEml({ subject: "never reached" })),
        ],
        { onEntry: (entry) => seen.push(entry) },
      );
      const drained = collect(stream).then(
        () => "finished",
        (error: Error) => error,
      );
      await expect(completed).rejects.toBeInstanceOf(ExportIntegrityError);
      const outcome = await drained;
      expect(outcome).toBeInstanceOf(Error);
      expect(seen.map((entry) => entry.status)).toEqual(["added"]);
    });

    it("also aborts on a mismatch in an empty message", async () => {
      const { stream, completed } = createEmlZip([
        testMessage("", { sha256: sha256Hex("something") }),
      ]);
      const drained = collect(stream).catch((error: Error) => error);
      await expect(completed).rejects.toBeInstanceOf(ExportIntegrityError);
      expect(await drained).toBeInstanceOf(Error);
    });

    it("records a message that cannot be opened as failed and continues", async () => {
      const seen: ExportEntry[] = [];
      const { archive, summary, entries } = await run(
        [
          testMessage(sampleEml({ subject: "before" }), { subject: "before" }),
          testMessage(sampleEml(), {
            subject: "broken open",
            open: () => {
              throw new Error("chunk index is unreachable");
            },
          }),
          testMessage(sampleEml(), {
            subject: "broken first read",
            open: () =>
              new Readable({
                read() {
                  this.destroy(
                    new Error(`storage returned an error ${String.fromCharCode(0x2014)} try again`),
                  );
                },
              }),
          }),
          testMessage(sampleEml({ subject: "after" }), { subject: "after" }),
        ],
        { onEntry: (entry) => seen.push(entry) },
      );
      expect(archive.length).toBeGreaterThan(0);
      expect(summary.messages).toBe(2);
      expect(summary.failed).toBe(2);
      expect(seen.map((entry) => entry.status)).toEqual(["added", "failed", "failed", "added"]);
      const failed = summary.entries.filter((entry) => entry.status === "failed");
      expect(failed[0]?.note).toBe("chunk index is unreachable");
      // No dash used as punctuation in a note.
      expect(failed[1]?.note).toBe("storage returned an error, try again");
      expect(failed[0]?.sha256).toBeNull();

      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      expect(byName.has("Inbox/2024-03-05 broken open.eml")).toBe(false);
      const manifest = parseManifest(
        (byName.get("MANIFEST.csv") as { data: Buffer }).data.toString(),
      );
      expect(manifest.map((row) => row.status)).toEqual(["added", "failed", "failed", "added"]);
      expect(manifest[1]).toMatchObject({
        entry: "Inbox/2024-03-05 broken open.eml",
        sha256: "",
        size: "0",
        note: "chunk index is unreachable",
      });
      // Failed messages are not in the checksum list; the rest verifies.
      const sums = (byName.get("SHA256SUMS") as { data: Buffer }).data.toString();
      expect(checkSha256Sums(sums, entries)).toHaveLength(3);
    });

    it("aborts when a message breaks after its first bytes are in the archive", async () => {
      const { stream, completed } = createEmlZip([
        testMessage(sampleEml(), {
          open: () => {
            let sent = false;
            return new Readable({
              read() {
                if (!sent) {
                  sent = true;
                  this.push(Buffer.from("From: a@example.test\r\n"));
                } else {
                  this.destroy(new Error("connection reset"));
                }
              },
            });
          },
        }),
      ]);
      const drained = collect(stream).catch((error: Error) => error);
      await expect(completed).rejects.toThrow("connection reset");
      expect(await drained).toBeInstanceOf(Error);
    });

    it("propagates an error of the message source", async () => {
      async function* source(): AsyncGenerator<ExportMessage> {
        yield testMessage(sampleEml());
        throw new Error("database went away");
      }
      const { stream, completed } = createEmlZip(source());
      const drained = collect(stream).catch((error: Error) => error);
      await expect(completed).rejects.toThrow("database went away");
      expect(await drained).toBeInstanceOf(Error);
    });
  });

  describe("cancellation", () => {
    it("rejects with JobAbortedError when the signal fires while a message is streaming", async () => {
      const controller = new AbortController();
      let opened = 0;
      const slow = (): Readable => {
        opened++;
        let count = 0;
        return new Readable({
          read() {
            // never ends on its own
            setTimeout(() => {
              this.push(Buffer.alloc(1024, count++ % 200));
              if (count === 3) {
                controller.abort();
              }
            }, 1);
          },
        });
      };
      const { stream, completed } = createEmlZip(
        [
          testMessage(sampleEml(), { subject: "one" }),
          testMessage(sampleEml(), { subject: "two", open: slow, withHash: false }),
          testMessage(sampleEml(), { subject: "three" }),
        ],
        { signal: controller.signal },
      );
      const drained = collect(stream).catch((error: Error) => error);
      await expect(completed).rejects.toBeInstanceOf(JobAbortedError);
      expect(await drained).toBeInstanceOf(Error);
      expect(opened).toBe(1);
    });

    it("rejects immediately when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const { stream, completed } = createEmlZip([testMessage(sampleEml())], {
        signal: controller.signal,
      });
      const drained = collect(stream).catch((error: Error) => error);
      await expect(completed).rejects.toBeInstanceOf(JobAbortedError);
      expect(await drained).toBeInstanceOf(Error);
    });

    it("stops waiting for the next message when the signal fires", async () => {
      const controller = new AbortController();
      async function* stalled(): AsyncGenerator<ExportMessage> {
        yield testMessage(sampleEml());
        await new Promise(() => undefined);
      }
      const { stream, completed } = createEmlZip(stalled(), { signal: controller.signal });
      const drained = collect(stream).catch((error: Error) => error);
      setTimeout(() => controller.abort(), 20);
      await expect(completed).rejects.toBeInstanceOf(JobAbortedError);
      expect(await drained).toBeInstanceOf(Error);
    });

    it("rejects `completed` when the consumer destroys the stream", async () => {
      const big = Buffer.from(sampleEml({ body: "y".repeat(2_000_000) }));
      const { stream, completed } = createEmlZip(
        Array.from({ length: 20 }, (_, i) =>
          testMessage(big, { subject: `m${i}`, chunkSize: 8192 }),
        ),
        { level: 1 },
      );
      stream.once("data", () => stream.destroy());
      await expect(completed).rejects.toThrow();
    });
  });

  it("reports progress through onEntry in order", async () => {
    const seen: string[] = [];
    await run(
      [testMessage(sampleEml(), { subject: "one" }), testMessage(sampleEml(), { subject: "two" })],
      { onEntry: (entry) => seen.push(`${entry.status}:${entry.name}`) },
    );
    expect(seen).toEqual(["added:Inbox/2024-03-05 one.eml", "added:Inbox/2024-03-05 two.eml"]);
  });

  it("sets the ZIP comment", async () => {
    const { archive } = await run([testMessage(sampleEml())], { comment: "Restow export test" });
    expect(archive.includes("Restow export test")).toBe(true);
  });

  it("defuses spreadsheet formulas in the manifest but not in the checksum list", async () => {
    const { entries } = await run([
      testMessage(sampleEml(), {
        subject: '=HYPERLINK("http://evil.example","x")',
        from: "@attacker <a@example.test>",
        to: "-2+3 <b@example.test>",
      }),
    ]);
    const manifest = parseManifest(
      (entries.find((e) => e.name === "MANIFEST.csv") as { data: Buffer }).data.toString(),
    );
    expect(manifest[0]?.subject).toBe('\'=HYPERLINK("http://evil.example","x")');
    expect(manifest[0]?.from).toBe("'@attacker <a@example.test>");
    expect(manifest[0]?.to).toBe("'-2+3 <b@example.test>");
  });

  const hasSha256sum = spawnSync("sha256sum", ["--version"]).status === 0;
  it.skipIf(!hasSha256sum)(
    "SHA256SUMS passes the real `sha256sum -c` on the extracted archive",
    async () => {
      const { entries } = await run([
        testMessage(sampleEml({ subject: "one" }), {
          folder: ["Inbox"],
          subject: "Gr\u00fc\u00dfe & [x] 'quoted'",
        }),
        testMessage(sampleEml({ subject: "two" }), {
          folder: ["Inbox", "A B"],
          subject: "two words",
        }),
        testMessage(sampleEml({ subject: "two" }), {
          folder: ["Inbox", "A B"],
          subject: "two words",
        }),
      ]);
      const root = mkdtempSync(join(tmpdir(), "restow-sums-"));
      try {
        for (const entry of entries) {
          const target = join(root, entry.name);
          if (entry.isDirectory) {
            mkdirSync(target, { recursive: true });
          } else {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, entry.data);
          }
        }
        const check = spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: root, encoding: "utf8" });
        expect(check.stderr).toBe("");
        expect(check.status).toBe(0);
        expect(check.stdout.split("\n").filter((line) => line.endsWith(": OK"))).toHaveLength(4);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
