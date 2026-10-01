/**
 * Regression tests for the hostile MSG file (finding H3): a compound file with a
 * looping sector chain made msgreader run the worker out of heap (fatal
 * "JavaScript heap out of memory", exit code 134) before any timeout, and a
 * crashed worker took the import job of every tenant with it, again and again
 * through the queue's retries. The files here are generated, not committed.
 */
import { afterAll, describe, expect, it } from "vitest";
import { shutdownIsolation } from "./isolate.js";
import { readMsg } from "./msg.js";
import { buildEml, buildMsg, buildZip, inputFileFromBuffer } from "./testing/builders.js";
import { type BuiltCfb, ENTRY, buildCfb, entryNamed } from "./testing/cfb.js";
import type { MailWalkEvent } from "./types.js";
import { walkMailFile } from "./walk.js";

afterAll(async () => {
  await shutdownIsolation();
});

/** A compound file shaped like an MSG: property streams, one of them big, one tiny. */
function message(): BuiltCfb {
  return buildCfb({
    entries: [
      { name: "__properties_version1.0", data: Buffer.alloc(100, 1) },
      { name: "__substg1.0_0037001F", data: Buffer.alloc(9000, 65) },
      { name: "__substg1.0_1000001F", data: Buffer.alloc(40, 66) },
    ],
  });
}

interface Hostile {
  readonly name: string;
  readonly build: () => Buffer;
}

const HOSTILE: readonly Hostile[] = [
  {
    name: "a directory chain that points back to itself",
    build: () => {
      const { bytes, layout } = message();
      const last = layout.directorySectors[layout.directorySectors.length - 1] as number;
      bytes.writeUInt32LE(last, layout.fatEntryOffset(last));
      return bytes;
    },
  },
  {
    name: "a stream whose FAT chain loops",
    build: () => {
      const { bytes, layout } = message();
      const big = entryNamed(layout, "__substg1.0_0037001F");
      bytes.writeUInt32LE(
        big.chain[0] as number,
        layout.fatEntryOffset(big.chain[big.chain.length - 1] as number),
      );
      bytes.writeUInt32LE(big.size + 4096, layout.entryOffset(big.index) + ENTRY.sizeLow);
      return bytes;
    },
  },
  {
    name: "a mini stream whose chain loops",
    build: () => {
      const { bytes, layout } = message();
      const small = entryNamed(layout, "__substg1.0_1000001F");
      bytes.writeUInt32LE(
        small.chain[0] as number,
        layout.miniFatEntryOffset(small.chain[0] as number),
      );
      bytes.writeUInt32LE(3000, layout.entryOffset(small.index) + ENTRY.sizeLow);
      return bytes;
    },
  },
  {
    name: "a mini stream container whose chain loops",
    build: () => {
      const { bytes, layout } = message();
      const sectors = layout.miniStreamSectors;
      bytes.writeUInt32LE(
        sectors[0] as number,
        layout.fatEntryOffset(sectors[sectors.length - 1] as number),
      );
      return bytes;
    },
  },
  {
    name: "a stream that claims two gigabytes",
    build: () => {
      const { bytes, layout } = message();
      const big = entryNamed(layout, "__substg1.0_0037001F");
      bytes.writeUInt32LE(0x7fffffff, layout.entryOffset(big.index) + ENTRY.sizeLow);
      return bytes;
    },
  },
  {
    name: "a directory tree whose sibling links loop",
    build: () => {
      const { bytes, layout } = message();
      bytes.writeUInt32LE(1, layout.entryOffset(3) + ENTRY.right);
      return bytes;
    },
  },
];

function reasonOf(result: Awaited<ReturnType<typeof readMsg>>): string {
  expect(result.ok).toBe(false);
  return (result as { reason: string }).reason;
}

describe("a hostile MSG file", { timeout: 120_000 }, () => {
  it("is reported as unreadable, quickly, for every kind of loop and size lie", async () => {
    for (const hostile of HOSTILE) {
      const started = Date.now();
      const result = await readMsg(hostile.build());
      expect(result, hostile.name).toMatchObject({ ok: false, code: "unreadable" });
      expect(reasonOf(result), hostile.name).toContain("is damaged (");
      expect(Date.now() - started, hostile.name).toBeLessThan(5000);
    }
  });

  it("cannot take the process down when the structure check does not catch it: the child process runs out of memory alone, and the caller never stalls", async () => {
    // The directory chain that points back to itself: on the main thread msgreader grows an
    // array without end until the whole process dies (about four gigabytes, 19 seconds).
    const bytes = HOSTILE[0]?.build() as Buffer;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = Date.now();
    const result = await readMsg(bytes, {
      structureCheck: false,
      heapLimitMb: 96,
      timeoutMs: 60_000,
    });
    clearInterval(timer);
    expect(result).toMatchObject({ ok: false, code: "unreadable" });
    expect(reasonOf(result)).toContain("more memory");
    expect(Date.now() - started).toBeLessThan(30_000);
    // This process is still here, its event loop kept running, and the reader still works.
    expect(ticks).toBeGreaterThan(5);
    const sound = await buildMsg({
      from: { address: "a@example.test" },
      to: [{ address: "b@example.test" }],
      subject: "still reading",
      body: "ok",
    });
    expect((await readMsg(sound)).ok).toBe(true);
  });

  it("does not stop an import: the item is listed as unreadable, the files around it are read", async () => {
    const zip = await buildZip([
      {
        name: "a.eml",
        data: buildEml({
          from: "a@example.test",
          to: "b@example.test",
          subject: "first",
          body: "1",
        }),
      },
      { name: "bad/loop.msg", data: HOSTILE[0]?.build() as Buffer },
      { name: "bad/size.msg", data: HOSTILE[4]?.build() as Buffer },
      {
        name: "z.eml",
        data: buildEml({
          from: "a@example.test",
          to: "b@example.test",
          subject: "last",
          body: "2",
        }),
      },
    ]);
    const events: MailWalkEvent[] = [];
    for await (const event of walkMailFile(inputFileFromBuffer("mail.zip", zip))) {
      events.push(event);
    }
    const messages = events.filter((event) => event.type === "message");
    const problems = events.filter((event) => event.type === "problem");
    expect(messages).toHaveLength(2);
    expect(problems.map((p) => (p.type === "problem" ? [p.ref, p.code] : null))).toEqual([
      ["mail.zip!bad/loop.msg", "unreadable"],
      ["mail.zip!bad/size.msg", "unreadable"],
    ]);
    for (const problem of problems) {
      expect((problem as { reason: string }).reason).toContain("damaged");
    }
  });
});
