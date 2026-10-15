import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readZip } from "../restore/testing/zip-reader.js";
import { type GuestFileReader, NOT_RESTORED_NAME, streamGuestZip } from "./guest-zip.js";
import { BufferSource, GuestFsError } from "./guestfs/source.js";
import { discoverVolumes, GuestFiles } from "./guestfs/volumes.js";

/** The ZIP of a VM restore point's files, over the in-process reader of a real image. */

async function reader(name: string): Promise<GuestFileReader> {
  const image = gunzipSync(
    readFileSync(new URL(`./guestfs/testdata/${name}.img.gz`, import.meta.url)),
  );
  const files = new GuestFiles(
    await discoverVolumes([{ device: "drive-scsi0", source: new BufferSource(image) }]),
  );
  return {
    list: (p) => files.list(p),
    stat: (p) => files.stat(p),
    open: async (p) => ({ size: (await files.open(p)).size }),
    read: async (p, o, l) => (await files.open(p)).read(o, l),
    failed: false,
  };
}

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

describe("the ZIP of a VM restore point's files", () => {
  it("holds a folder the way it was chosen, a file under its name, and lists what it left out", async () => {
    let ended = 0;
    const zip = streamGuestZip({
      reader: await reader("gpt-efi-ext4"),
      selection: [
        { path: "/scsi0-p2/home/anna", type: "dir" },
        { path: "/scsi0-p2/etc/hostname", type: "file" },
        { path: "/scsi0-p2/var", type: "dir" },
        { path: "/scsi0-p2/link", type: "dir" },
      ],
      onEnd: () => {
        ended++;
      },
    });
    const entries = readZip(await collect(zip));
    const names = entries.map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "anna/",
        "anna/Documents/",
        "anna/Documents/report 2026.txt",
        "anna/notes.txt",
        "anna/ümlaut-é.txt",
        "hostname",
        "var/log/big.bin",
      ]),
    );
    const text = (name: string) => entries.find((e) => e.name === name)?.data.toString("utf8");
    expect(text("anna/notes.txt")).toBe("Hello Anna\n");
    expect(text("hostname")).toBe("web01\n");
    expect(entries.find((e) => e.name === "var/log/big.bin")?.data.length).toBe(300 * 1024 + 123);
    // The symbolic link was chosen as a folder: it is not followed, and the ZIP says so.
    expect(text(NOT_RESTORED_NAME)).toContain("/scsi0-p2/link");
    expect(ended).toBe(1);
  });

  it("names a file the reader cannot read instead of breaking the download", async () => {
    const base = await reader("gpt-efi-ext4");
    const zip = streamGuestZip({
      reader: {
        ...base,
        open: async (path) => {
          if (path.endsWith("notes.txt"))
            throw new GuestFsError("unsupported", "the file is NTFS-compressed");
          return base.open(path);
        },
      },
      selection: [{ path: "/scsi0-p2/home/anna", type: "dir" }],
    });
    const entries = readZip(await collect(zip));
    expect(entries.map((e) => e.name)).not.toContain("anna/notes.txt");
    expect(entries.find((e) => e.name === NOT_RESTORED_NAME)?.data.toString()).toContain(
      "/scsi0-p2/home/anna/notes.txt\tthe file is NTFS-compressed",
    );
  });

  it("breaks the download when the reader itself ended", async () => {
    const base = await reader("gpt-efi-ext4");
    const failing: GuestFileReader = {
      ...base,
      failed: true,
      open: async () => {
        throw new GuestFsError("damaged", "the reader ended (SIGKILL)");
      },
    };
    const zip = streamGuestZip({
      reader: failing,
      selection: [{ path: "/scsi0-p2/etc", type: "dir" }],
    });
    await expect(collect(zip)).rejects.toThrow();
  });
});
