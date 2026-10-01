import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunLog, formatBytes, hashUnchanged, sampleCandidates, shortId } from "./endpoint-agent.js";
import { mulberry32 } from "./prng.js";
import type { ResticNode } from "./restic.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const node = (path: string, size = 10, type = "file", mtime: Date | null = null): ResticNode => ({
  name: path.split("/").pop() ?? "",
  type,
  path,
  size,
  mtime,
});

describe("RunLog", () => {
  it("stamps lines with the clock it was given, in the agent's format", () => {
    const log = new RunLog(() => new Date("2026-09-01T20:07:11.456Z"));
    log.info("Run started");
    log.warn("careful");
    log.error("broken");
    log.raw("restic", "one\n\ntwo");
    expect(log.tail().split("\n")).toEqual([
      "2026-09-01T20:07:11Z INFO Run started",
      "2026-09-01T20:07:11Z WARN careful",
      "2026-09-01T20:07:11Z ERROR broken",
      "2026-09-01T20:07:11Z INFO restic: one",
      "2026-09-01T20:07:11Z INFO restic: two",
    ]);
  });

  it("keeps the last 200 lines", () => {
    const log = new RunLog(() => new Date("2026-09-01T00:00:00Z"));
    for (let i = 0; i < 250; i++) log.info(`line ${i}`);
    const lines = log.tail().split("\n");
    expect(lines).toHaveLength(200);
    expect(lines[0]).toContain("line 50");
    expect(lines[199]).toContain("line 249");
  });
});

describe("formatting", () => {
  it("shortens snapshot ids to eight characters", () => {
    expect(shortId("0123456789abcdef")).toBe("01234567");
    expect(shortId("abc")).toBe("abc");
  });

  it("writes byte counts in binary units like the agent", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });
});

describe("sampleCandidates", () => {
  const nodes = [
    ...Array.from({ length: 60 }, (_, i) => node(`/srv/share/file-${i}.txt`, 100 + i)),
    node("/srv/share", 0, "dir"),
    node("/srv/share/empty.txt", 0),
    node("/srv/share/link", 5, "symlink"),
    node("relative/path.txt", 5),
  ];

  it("takes regular, non-empty files with absolute paths only", () => {
    const sample = sampleCandidates(nodes, mulberry32(1), 6, 24);
    expect(sample).toHaveLength(24);
    for (const picked of sample) {
      expect(picked.type).toBe("file");
      expect(picked.size).toBeGreaterThan(0);
      expect(picked.path.startsWith("/")).toBe(true);
      expect(picked.path).not.toContain("empty");
    }
    expect(new Set(sample.map((n) => n.path)).size).toBe(sample.length);
  });

  it("is deterministic for a seed, differs between seeds and keeps everything of a small snapshot", () => {
    const again = sampleCandidates(nodes, mulberry32(1), 6, 24).map((n) => n.path);
    expect(sampleCandidates(nodes, mulberry32(1), 6, 24).map((n) => n.path)).toEqual(again);
    expect(sampleCandidates(nodes, mulberry32(2), 6, 24).map((n) => n.path)).not.toEqual(again);
    const small = sampleCandidates(nodes.slice(0, 3), mulberry32(1), 6, 24);
    expect(small.map((n) => n.path).sort()).toEqual([
      "/srv/share/file-0.txt",
      "/srv/share/file-1.txt",
      "/srv/share/file-2.txt",
    ]);
  });
});

describe("hashUnchanged", () => {
  function fileWith(content: string, mtime: Date): string {
    const dir = mkdtempSync(join(tmpdir(), "restow-sample-"));
    dirs.push(dir);
    const path = join(dir, "a.txt");
    writeFileSync(path, content);
    utimesSync(path, mtime, mtime);
    return path;
  }

  it("hashes a file that still is what the snapshot saw", async () => {
    const mtime = new Date("2026-08-01T10:00:00Z");
    const path = fileWith("hello", mtime);
    expect(await hashUnchanged(node(path, 5, "file", mtime))).toEqual({
      path,
      // sha256("hello")
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      size: 5,
    });
  });

  it("refuses a file that changed in size or modification time, or is gone", async () => {
    const mtime = new Date("2026-08-01T10:00:00Z");
    const path = fileWith("hello", mtime);
    expect(await hashUnchanged(node(path, 6, "file", mtime))).toBeNull();
    expect(await hashUnchanged(node(path, 5, "file", new Date("2026-08-01T10:05:00Z")))).toBeNull();
    expect(await hashUnchanged(node(`${path}.gone`, 5, "file", mtime))).toBeNull();
  });
});
