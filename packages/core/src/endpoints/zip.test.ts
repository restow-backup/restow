import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readZip } from "../restore/testing/zip-reader.js";
import {
  type ResticSession,
  resticBinary,
  resticInit,
  resticSnapshots,
  runRestic,
} from "./restic-cli.js";
import {
  parentPrefix,
  safeEntryName,
  streamSnapshotZip,
  tarEntrySnapshotPath,
  UniqueNames,
} from "./zip.js";

function resticAvailable(): boolean {
  return spawnSync(resticBinary(), ["version"], { stdio: "ignore" }).status === 0;
}

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

describe("leaving files out of a ZIP", () => {
  it("names a tar entry by its path in the snapshot", () => {
    expect(tarEntrySnapshotPath("etc/restow-agent/state.json")).toBe(
      "/etc/restow-agent/state.json",
    );
    expect(tarEntrySnapshotPath("etc/luks-keys/")).toBe("/etc/luks-keys");
    expect(tarEntrySnapshotPath("C/ProgramData/Restow/state/state.json")).toBe(
      "/C/ProgramData/Restow/state/state.json",
    );
  });

  it.skipIf(!resticAvailable())(
    "skips the files the caller names, in a folder and as a single file",
    async () => {
      const work = await mkdtemp(join(tmpdir(), "restow-zip-skip-"));
      try {
        const source = join(work, "source");
        await mkdir(join(source, "etc", "restow-agent"), { recursive: true });
        await mkdir(join(source, "etc", "luks-keys"), { recursive: true });
        await writeFile(join(source, "etc", "hosts"), "127.0.0.1 localhost\n");
        await writeFile(join(source, "etc", "restow-agent", "state.json"), '{"secret":1}');
        await writeFile(join(source, "etc", "restow-agent", "agent.json"), "{}");
        await writeFile(join(source, "etc", "luks-keys", "data.key"), "key");
        const session: ResticSession = {
          repositoryUrl: join(work, "repo"),
          username: "",
          password: "",
          repositoryPassword: "repository-password-for-tests",
          cacheDir: join(work, "cache"),
        };
        await resticInit(session);
        await runRestic(session, ["backup", "--host", "test-host", source]);
        const snapshotId = (await resticSnapshots(session))[0]?.id ?? "";
        const locked = new Set([
          `${source}/etc/restow-agent/state.json`,
          `${source}/etc/luks-keys/data.key`,
        ]);
        const zip = streamSnapshotZip({
          session,
          snapshotId,
          paths: [`${source}/etc`, `${source}/etc/luks-keys/data.key`],
          selection: [
            { path: `${source}/etc`, type: "dir" },
            { path: `${source}/etc/luks-keys/data.key`, type: "file" },
          ],
          skip: (path) => locked.has(path),
        });
        const chunks: Buffer[] = [];
        for await (const chunk of zip.stream) chunks.push(chunk as Buffer);
        const names = readZip(Buffer.concat(chunks)).map((entry) => entry.name);
        expect(names).toContain("etc/hosts");
        expect(names).toContain("etc/restow-agent/agent.json");
        expect(names).toContain("etc/luks-keys/");
        expect(
          names.filter((name) => name.endsWith("state.json") || name.endsWith(".key")),
        ).toEqual([]);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
