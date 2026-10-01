import { describe, expect, it } from "vitest";
import { buildEml, buildRawZip, buildZip, inputFileFromBuffer } from "./testing/builders.js";
import { type ZipEvent, iterateZip, sanitizeArchivePath } from "./zip.js";

interface Content {
  text: string | Error;
  head: Buffer | Error;
}

/** Entries are only valid while the iterator waits, so their content is read inside the loop. */
const contents = new WeakMap<ZipEvent, Content>();

async function collect(
  buffer: Buffer,
  options: Parameters<typeof iterateZip>[1] = {},
): Promise<ZipEvent[]> {
  const events: ZipEvent[] = [];
  for await (const event of iterateZip(
    inputFileFromBuffer("test.zip", buffer, { chunkSize: 4096 }),
    options,
  )) {
    events.push(event);
    if (event.kind === "entry") {
      const content: Content = { text: "", head: Buffer.alloc(0) };
      try {
        content.head = await event.head();
      } catch (error) {
        content.head = error as Error;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of await event.open()) {
          chunks.push(chunk as Buffer);
        }
        content.text = Buffer.concat(chunks).toString("utf8");
      } catch (error) {
        content.text = error as Error;
      }
      contents.set(event, content);
    }
  }
  return events;
}

const summary = (events: ZipEvent[]): string[] =>
  events.map((event) =>
    event.kind === "directory"
      ? `dir:${event.path.join("/")}`
      : event.kind === "entry"
        ? `entry:${event.name}`
        : `problem:${event.code}:${event.name ?? "-"}`,
  );

function textOf(event: ZipEvent | undefined): string {
  const content = event ? contents.get(event) : undefined;
  expect(content).toBeDefined();
  if ((content as Content).text instanceof Error) {
    throw (content as Content).text;
  }
  return (content as Content).text as string;
}

function headOf(event: ZipEvent | undefined): Buffer {
  const content = event ? contents.get(event) : undefined;
  if ((content as Content).head instanceof Error) {
    throw (content as Content).head;
  }
  return (content as Content).head as Buffer;
}

describe("sanitizeArchivePath", () => {
  it("splits on both separators and drops unsafe components", () => {
    expect(sanitizeArchivePath("a/b/c.eml")).toEqual(["a", "b", "c.eml"]);
    expect(sanitizeArchivePath("a\\b\\c.eml")).toEqual(["a", "b", "c.eml"]);
    expect(sanitizeArchivePath("../../etc/passwd")).toEqual(["etc", "passwd"]);
    expect(sanitizeArchivePath("/abs/olute.eml")).toEqual(["abs", "olute.eml"]);
    expect(sanitizeArchivePath("C:\\Users\\x\\mail.eml")).toEqual(["Users", "x", "mail.eml"]);
    expect(sanitizeArchivePath("a/./b//c/../d")).toEqual(["a", "b", "c", "d"]);
    expect(sanitizeArchivePath("dir/")).toEqual(["dir"]);
    expect(sanitizeArchivePath("a\u0000b/\u0007c.eml")).toEqual(["ab", "c.eml"]);
    expect(sanitizeArchivePath("")).toEqual([]);
    expect(sanitizeArchivePath("../")).toEqual([]);
    expect(sanitizeArchivePath("...")).toEqual(["..."]);
    expect(sanitizeArchivePath("C:file.eml")).toEqual(["C:file.eml"]);
  });
});

describe("iterateZip", () => {
  const eml = (subject: string) =>
    buildEml({ from: "a@example.test", to: "b@example.test", subject, body: subject });

  it("yields entries and directories in central directory order", async () => {
    const zip = await buildZip([
      { name: "Inbox/" },
      { name: "Inbox/a.eml", data: eml("a") },
      { name: "top.eml", data: eml("top") },
      { name: "Empty/" },
      { name: "Sent/deep/b.eml", data: eml("b"), store: true },
    ]);
    const events = await collect(zip);
    expect(summary(events)).toEqual([
      "dir:Inbox",
      "entry:Inbox/a.eml",
      "entry:top.eml",
      "dir:Empty",
      "entry:Sent/deep/b.eml",
    ]);
    const entry = events[1] as Extract<ZipEvent, { kind: "entry" }>;
    expect(entry.size).toBe(eml("a").length);
    expect(entry.components).toEqual(["Inbox", "a.eml"]);
    expect(textOf(entry)).toBe(eml("a").toString("utf8"));
    expect(textOf(events[4])).toBe(eml("b").toString("utf8"));
  });

  it("yields nothing for an empty archive", async () => {
    expect(await collect(await buildZip([]))).toEqual([]);
  });

  it("head() returns at most the first 64 KiB and does not read the rest", async () => {
    const big = Buffer.from(
      Array.from({ length: 1024 * 1024 }, (_, i) => (i * 7919 + (i >> 5)) % 251),
    );
    const zip = await buildZip([
      { name: "big.txt", data: big },
      { name: "small.txt", data: "hello" },
    ]);
    const events = await collect(zip);
    const head = headOf(events[0]);
    expect(head.length).toBe(64 * 1024);
    expect(head.equals(big.subarray(0, 64 * 1024))).toBe(true);
    expect(headOf(events[1]).toString()).toBe("hello");
    expect(Buffer.from(textOf(events[0]), "latin1").length).toBeGreaterThan(64 * 1024);
  });

  it("can open an entry more than once while the iterator waits", async () => {
    const zip = await buildZip([{ name: "a.txt", data: "twice" }]);
    for await (const event of iterateZip(inputFileFromBuffer("a.zip", zip))) {
      if (event.kind !== "entry") {
        continue;
      }
      for (let round = 0; round < 2; round++) {
        const chunks: Buffer[] = [];
        for await (const chunk of await event.open()) {
          chunks.push(chunk as Buffer);
        }
        expect(Buffer.concat(chunks).toString()).toBe("twice");
      }
    }
  });

  describe("names", () => {
    it("sanitises zip-slip, absolute and backslash names", async () => {
      const zip = buildRawZip([
        { name: "../../evil.eml", data: "x" },
        { name: "/abs/olute.eml", data: "x" },
        { name: "a\\b\\c.eml", data: "x" },
        { name: "C:\\Windows\\w.eml", data: "x" },
        { name: "dir/../../up.eml", data: "x" },
        { name: "..\\..\\back.eml", data: "x" },
        { name: "../", data: "" },
        { name: "sub\\", data: "" },
      ]);
      const events = await collect(zip);
      expect(summary(events)).toEqual([
        "entry:evil.eml",
        "entry:abs/olute.eml",
        "entry:a/b/c.eml",
        "entry:Windows/w.eml",
        "entry:dir/up.eml",
        "entry:back.eml",
        "dir:sub",
      ]);
      for (const event of events) {
        if (event.kind === "entry") {
          expect(event.name.startsWith("/")).toBe(false);
          expect(event.components.includes("..")).toBe(false);
        }
      }
    });

    it("reports an entry with no usable name", async () => {
      const events = await collect(
        buildRawZip([
          { name: "..", data: "x" },
          { name: "ok.eml", data: "x" },
        ]),
      );
      expect(summary(events)).toEqual(["problem:unreadable:-", "entry:ok.eml"]);
    });

    it("decodes UTF-8 names and legacy CP437 names", async () => {
      const zip = buildRawZip([
        { name: "K\u00f6ln/gr\u00fc\u00dfe \u30c6\u30b9\u30c8.eml", data: "x" },
        {
          name: Buffer.from([0x81, 0x6d, 0x6c, 0x61, 0x75, 0x74, 0x2e, 0x65, 0x6d, 0x6c]),
          utf8: false,
          data: "x",
        },
      ]);
      const events = await collect(zip);
      expect(summary(events)).toEqual([
        "entry:K\u00f6ln/gr\u00fc\u00dfe \u30c6\u30b9\u30c8.eml",
        "entry:\u00fcmlaut.eml",
      ]);
    });
  });

  describe("guards", () => {
    it("reports encrypted entries as unsupported and carries on", async () => {
      const zip = buildRawZip([
        { name: "secret.eml", data: "cipher", encrypted: true },
        { name: "plain.eml", data: "x" },
      ]);
      const events = await collect(zip);
      expect(summary(events)).toEqual(["problem:unsupported:secret.eml", "entry:plain.eml"]);
      expect((events[0] as { reason: string }).reason).toMatch(/password/);
    });

    it("reports compression methods it cannot decode as unsupported", async () => {
      const zip = buildRawZip([
        { name: "bz.eml", data: "x", methodOverride: 12 },
        { name: "ok.eml", data: "x" },
      ]);
      expect(summary(await collect(zip))).toEqual(["problem:unsupported:bz.eml", "entry:ok.eml"]);
    });

    it("stops at an archive with too many entries", async () => {
      const zip = await buildZip([
        { name: "a.eml", data: "1" },
        { name: "b.eml", data: "2" },
        { name: "c.eml", data: "3" },
      ]);
      const events = await collect(zip, { limits: { maxZipEntries: 2 } });
      expect(summary(events)).toEqual(["problem:limit:-"]);
      expect((events[0] as { reason: string }).reason).toContain("3 entries");
      expect(summary(await collect(zip, { limits: { maxZipEntries: 3 } }))).toHaveLength(3);
    });

    it("stops once the entries expand beyond the total limit", async () => {
      const zip = await buildZip([
        { name: "a.txt", data: "x".repeat(1000) },
        { name: "b.txt", data: "x".repeat(1000) },
        { name: "c.txt", data: "x".repeat(1000) },
      ]);
      const events = await collect(zip, {
        limits: { maxZipExpandedBytes: 2500, maxZipRatio: 1_000_000 },
      });
      expect(summary(events)).toEqual(["entry:a.txt", "entry:b.txt", "problem:limit:c.txt"]);
      // Sizes of skipped-over entries still count: the limit is a property of the archive, not of what was read.
      expect((events[2] as { reason: string }).reason).toContain("remaining entries were not read");
    });

    it("refuses an entry with an implausible compression ratio", async () => {
      const bomb = buildRawZip([
        { name: "bomb.txt", data: "x", declaredSize: 4_000_000_000 },
        { name: "fine.txt", data: "hello" },
      ]);
      const events = await collect(bomb);
      expect(summary(events)).toEqual(["problem:limit:bomb.txt", "entry:fine.txt"]);
      expect((events[0] as { reason: string }).reason).toContain("decompression bomb");
    });

    it("applies the ratio limit that is passed in", async () => {
      const zip = await buildZip([{ name: "zeros.bin", data: Buffer.alloc(200_000) }]);
      expect(summary(await collect(zip, { limits: { maxZipRatio: 10 } }))).toEqual([
        "problem:limit:zeros.bin",
      ]);
      expect(summary(await collect(zip))).toEqual(["entry:zeros.bin"]);
    });

    it("treats a stored entry whose sizes disagree as a damaged archive", async () => {
      const zip = buildRawZip([{ name: "lie.txt", data: "", method: 0, declaredSize: 5 }]);
      expect(summary(await collect(zip))).toEqual(["problem:unreadable:-"]);
    });

    it("notices an entry whose real size differs from the headers when it is read", async () => {
      const zip = buildRawZip([
        {
          name: "liar.txt",
          data: "x".repeat(5000),
          declaredSize: 100,
          declaredCompressedSize: undefined,
        },
      ]);
      const events = await collect(zip);
      expect(summary(events)).toEqual(["entry:liar.txt"]);
      expect(() => textOf(events[0])).toThrow(/too many bytes/);
    });
  });

  describe("damaged archives", () => {
    it("reports garbage as unreadable", async () => {
      const events = await collect(
        Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 1)]),
      );
      expect(summary(events)).toEqual(["problem:unreadable:-"]);
    });

    it("reports a truncated archive as unreadable", async () => {
      const zip = await buildZip([
        { name: "a.eml", data: "x".repeat(5000) },
        { name: "b.eml", data: "y" },
      ]);
      for (const cut of [10, 100, zip.length - 30, zip.length - 1]) {
        const events = await collect(zip.subarray(0, cut));
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.kind === "problem")).toBe(true);
      }
    });

    it("ends with a problem when the central directory breaks after some entries", async () => {
      const zip = buildRawZip([
        { name: "a.eml", data: "x" },
        { name: "b.eml", data: "y" },
        { name: "c.eml", data: "z" },
      ]);
      const broken = Buffer.from(zip);
      // Find the third central directory header signature and corrupt it.
      let seen = 0;
      for (let i = 0; i < broken.length - 4; i++) {
        if (broken.readUInt32LE(i) === 0x02014b50 && ++seen === 3) {
          broken.writeUInt32LE(0xdeadbeef, i);
          break;
        }
      }
      const events = await collect(broken);
      expect(summary(events)).toEqual(["entry:a.eml", "entry:b.eml", "problem:unreadable:-"]);
    });

    it("reports a read error of the underlying file as unreadable", async () => {
      const zip = await buildZip([{ name: "a.eml", data: "x" }]);
      const file = inputFileFromBuffer("bad.zip", zip);
      const failing = {
        ...file,
        read: async () => {
          throw new Error("segment 3 is missing from the storage target: secret-key-name");
        },
      };
      const events: ZipEvent[] = [];
      for await (const event of iterateZip(failing)) {
        events.push(event);
      }
      expect(summary(events)).toEqual(["problem:unreadable:-"]);
      // The message of a storage error must not leak into the report.
      expect((events[0] as { reason: string }).reason).not.toContain("secret-key-name");
    });
  });

  it("throws an AbortError when aborted", async () => {
    const zip = await buildZip([
      { name: "a.eml", data: "x" },
      { name: "b.eml", data: "y" },
    ]);
    const controller = new AbortController();
    const iterator = iterateZip(inputFileFromBuffer("a.zip", zip), { signal: controller.signal });
    expect((await iterator.next()).value).toMatchObject({ kind: "entry" });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError", message: "aborted" });
  });

  it("reads a large number of entries", async () => {
    const entries = Array.from({ length: 3000 }, (_, i) => ({
      name: `dir${i % 30}/m${i}.eml`,
      data: `m${i}`,
    }));
    const zip = await buildZip(entries);
    const events: ZipEvent[] = [];
    for await (const event of iterateZip(inputFileFromBuffer("many.zip", zip))) {
      events.push(event);
    }
    expect(events).toHaveLength(3000);
    expect(events[0]).toMatchObject({ kind: "entry", name: "dir0/m0.eml" });
    expect(events[2999]).toMatchObject({ kind: "entry", name: "dir29/m2999.eml" });
  }, 60_000);

  it("uses no more memory than the entries being read: reads arrive in ranges", async () => {
    const zip = await buildZip([
      { name: "a.txt", data: Buffer.alloc(2_000_000, 0x41) },
      { name: "b.txt", data: "b" },
    ]);
    const file = inputFileFromBuffer("r.zip", zip);
    let biggest = 0;
    const spy = {
      ...file,
      read: async (offset: number, length: number) => {
        biggest = Math.max(biggest, length);
        return file.read(offset, length);
      },
    };
    const events: ZipEvent[] = [];
    for await (const event of iterateZip(spy)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(biggest).toBeLessThanOrEqual(256 * 1024);
  });
});
