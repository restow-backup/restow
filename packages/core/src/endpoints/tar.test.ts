import { PassThrough } from "node:stream";
import archiver from "archiver";
import { describe, expect, it } from "vitest";
import { parsePax, readTar } from "./tar.js";

async function tarOf(
  entries: { name: string; content?: string; directory?: boolean }[],
): Promise<Buffer> {
  const archive = archiver("tar");
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => sink.on("end", () => resolve()));
  archive.pipe(sink);
  for (const entry of entries) {
    if (entry.directory) {
      archive.append(Buffer.alloc(0), { name: `${entry.name}/`, type: "directory" } as never);
    } else {
      archive.append(Buffer.from(entry.content ?? ""), { name: entry.name });
    }
  }
  await archive.finalize();
  await finished;
  return Buffer.concat(chunks);
}

async function readAll(buffer: Buffer) {
  const result: { name: string; type: string; size: number; text: string }[] = [];
  const source = (async function* () {
    // Feed the archive in odd-sized pieces to exercise the block buffering.
    for (let offset = 0; offset < buffer.length; offset += 700) {
      yield buffer.subarray(offset, offset + 700);
    }
  })();
  for await (const entry of readTar(source)) {
    const parts: Buffer[] = [];
    for await (const part of entry.body) {
      parts.push(part as Buffer);
    }
    result.push({
      name: entry.name,
      type: entry.type,
      size: entry.size,
      text: Buffer.concat(parts).toString("utf8"),
    });
  }
  return result;
}

describe("reading the tar archives of restic dump", () => {
  it("reads files and folders in order", async () => {
    const tar = await tarOf([
      { name: "home/anna", directory: true },
      { name: "home/anna/a.txt", content: "hello" },
      { name: "home/anna/empty.txt", content: "" },
      { name: "home/anna/big.bin", content: "x".repeat(5000) },
    ]);
    const entries = await readAll(tar);
    expect(entries.map((entry) => [entry.name, entry.type, entry.size])).toEqual([
      ["home/anna/", "directory", 0],
      ["home/anna/a.txt", "file", 5],
      ["home/anna/empty.txt", "file", 0],
      ["home/anna/big.bin", "file", 5000],
    ]);
    expect(entries[1]?.text).toBe("hello");
    expect(entries[3]?.text).toHaveLength(5000);
  });

  it("reads names longer than the 100 bytes of the header (PAX or prefix)", async () => {
    const name = `${"very-long-folder-name/".repeat(8)}file.txt`;
    expect(name.length).toBeGreaterThan(150);
    const entries = await readAll(await tarOf([{ name, content: "deep" }]));
    expect(entries[0]?.name).toBe(name);
    expect(entries[0]?.text).toBe("deep");
  });

  it("reads non-ASCII names", async () => {
    const entries = await readAll(await tarOf([{ name: "Übersicht/Größe €.txt", content: "ü" }]));
    expect(entries[0]?.name).toBe("Übersicht/Größe €.txt");
  });

  it("skips what the caller did not read of an entry", async () => {
    const tar = await tarOf([
      { name: "a.txt", content: "y".repeat(3000) },
      { name: "b.txt", content: "second" },
    ]);
    const names: string[] = [];
    let second = "";
    const source = (async function* () {
      yield tar;
    })();
    for await (const entry of readTar(source)) {
      names.push(entry.name);
      if (entry.name === "b.txt") {
        for await (const part of entry.body) {
          second += (part as Buffer).toString();
        }
      }
    }
    expect(names).toEqual(["a.txt", "b.txt"]);
    expect(second).toBe("second");
  });

  it("stops at an empty archive and refuses a corrupt header", async () => {
    expect(await readAll(Buffer.alloc(1024))).toEqual([]);
    const tar = await tarOf([{ name: "a.txt", content: "x" }]);
    tar[10] = (tar[10] ?? 0) ^ 0xff;
    await expect(readAll(tar)).rejects.toThrow(/checksum/);
  });

  it("parses PAX records", () => {
    const record = (key: string, value: string) => {
      const body = ` ${key}=${value}\n`;
      let length = body.length + 1;
      length = `${length}${body}`.length;
      return `${length}${body}`;
    };
    const pax = parsePax(Buffer.from(record("path", "a/b/c.txt") + record("size", "42")));
    expect(pax.get("path")).toBe("a/b/c.txt");
    expect(pax.get("size")).toBe("42");
  });
});
