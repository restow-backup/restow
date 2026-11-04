import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResticSession } from "./restic-cli.js";
import { parentPrefix, safeEntryName, streamSnapshotZip, UniqueNames } from "./zip.js";

describe("ZIP entry names", () => {
  it("cannot climb out of the archive", () => {
    expect(safeEntryName("../../etc/passwd")).toBe("etc/passwd");
    expect(safeEntryName("/abs/./path//file")).toBe("abs/path/file");
    expect(safeEntryName("a/../b")).toBe("a/b");
    expect(safeEntryName("..")).toBe("");
    expect(safeEntryName("dir", true)).toBe("dir/");
    expect(safeEntryName("", true)).toBe("");
  });

  it("gives a Windows extractor no backslash, drive or stream to follow", () => {
    // A Linux file may be called `..\..\x`; unpacked on Windows it must stay one file.
    expect(safeEntryName("..\\..\\x")).toBe(".._.._x");
    expect(safeEntryName("docs/..\\..\\Windows\\win.ini")).toBe("docs/.._.._Windows_win.ini");
    expect(safeEntryName("C:/Windows/system.ini")).toBe("C_/Windows/system.ini");
    expect(safeEntryName("C:evil")).toBe("C_evil");
    expect(safeEntryName("file.txt:stream")).toBe("file.txt_stream");
    expect(safeEntryName("a\u0000b\nc")).toBe("a_b_c");
    // Dots-only segments are no names on Windows either.
    expect(safeEntryName(".../x/....")).toBe("x");
    expect(safeEntryName("\\", true)).toBe("_/");
    // Ordinary names are left alone.
    expect(safeEntryName("home/anna/Bericht 2026 (final).pdf")).toBe(
      "home/anna/Bericht 2026 (final).pdf",
    );
    expect(safeEntryName(".config/app.json")).toBe(".config/app.json");
  });

  it("keeps names unique within one archive", () => {
    const names = new UniqueNames();
    expect(names.claim("docs/x.txt")).toBe("docs/x.txt");
    expect(names.claim("docs/x.txt")).toBe("docs/x (2).txt");
    expect(names.claim("docs/x.txt")).toBe("docs/x (3).txt");
    expect(names.claim("noext")).toBe("noext");
    expect(names.claim("noext")).toBe("noext (2)");
    expect(names.claim("dir.v1/file")).toBe("dir.v1/file");
    expect(names.claim("dir.v1/file")).toBe("dir.v1/file (2)");
  });

  it("strips the folders above a selected folder, so the ZIP shows what the user chose", () => {
    expect(parentPrefix("/home/anna/docs")).toBe("home/anna/");
    expect(parentPrefix("/home/anna/docs/")).toBe("home/anna/");
    expect(parentPrefix("/etc")).toBe("");
    expect(parentPrefix("/")).toBe("");
  });
});

describe.skipIf(process.platform === "win32")("ZIP download that ends early", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  /**
   * A stand-in for restic: `dump` writes its pid, then (for a folder) a tar header that fails
   * its checksum, then output without end, as a large file would. Left unread it blocks on the
   * full pipe and never ends by itself.
   */
  async function fakeRestic(): Promise<{ session: ResticSession; pid: () => Promise<number> }> {
    dir = await mkdtemp(join(tmpdir(), "restow-zip-"));
    const pidFile = join(dir, "pid");
    const binary = join(dir, "restic");
    await writeFile(
      binary,
      [
        "#!/bin/sh",
        `echo $$ > '${pidFile}'`,
        `if [ "$2" = "--archive" ]; then printf '%0512d' 0 | tr 0 x; fi`,
        "exec yes restic",
        "",
      ].join("\n"),
    );
    await chmod(binary, 0o755);
    const session: ResticSession = {
      repositoryUrl: "rest:http://127.0.0.1:1/",
      username: "u",
      password: "p",
      repositoryPassword: "r",
      cacheDir: dir,
      binary,
    };
    const pid = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const text = await readFile(pidFile, "utf8").catch(() => "");
        if (text.trim()) return Number(text.trim());
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("the fake restic never started");
    };
    return { session, pid };
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function ended(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!alive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  it("stops restic dump when its tar is broken, and the download fails", async () => {
    const { session, pid } = await fakeRestic();
    const zip = streamSnapshotZip({
      session,
      snapshotId: "abcdef12",
      paths: ["/etc"],
      selection: [{ path: "/etc", type: "dir" }],
    });
    const failed = new Promise<Error>((resolve) => zip.stream.once("error", resolve));
    zip.stream.resume();
    expect((await failed).message).toBe("tar header checksum mismatch");
    const child = await pid();
    // Without anyone reading its output it would wait on the pipe for good.
    expect(await ended(child)).toBe(true);
  });

  it("stops restic dump when the client leaves in the middle of a file", async () => {
    const { session, pid } = await fakeRestic();
    const zip = streamSnapshotZip({
      session,
      snapshotId: "abcdef12",
      paths: ["/big.iso"],
      selection: [{ path: "/big.iso", type: "file" }],
    });
    const child = await pid();
    // Some bytes arrive, then the response is torn down (no abort signal given).
    await new Promise<void>((resolve) => zip.stream.once("data", () => resolve()));
    zip.stream.destroy();
    expect(await ended(child)).toBe(true);
  });
});
