import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ResticSession,
  resticBinary,
  resticSnapshots,
  runRestic,
} from "../endpoints/restic-cli.js";
import { catalogChangeOf, catalogNodeOf } from "./catalog.js";
import { resticDiffLines, resticLsLines } from "./restic.js";

function resticAvailable(): boolean {
  const result = spawnSync(resticBinary(), ["version"], { encoding: "utf8" });
  return result.status === 0;
}

describe.skipIf(!resticAvailable())("restic diff and ls for the catalog", () => {
  let work: string;
  let session: ResticSession;
  let root: string;
  let ids: string[] = [];

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "restow-share-restic-"));
    root = join(work, "share");
    await mkdir(join(root, "sub"), { recursive: true });
    session = {
      repositoryUrl: join(work, "repo"),
      username: "u",
      password: "p",
      repositoryPassword: "repository-password",
      cacheDir: join(work, "cache"),
    };
    await runRestic(session, ["init"]);
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "sub", "b.txt"), "b");
    await runRestic(session, ["backup", "--json", root]);
    await writeFile(join(root, "a.txt"), "a2");
    await rm(join(root, "sub", "b.txt"));
    await writeFile(join(root, "c.txt"), "c");
    await runRestic(session, ["backup", "--json", root]);
    // Newest first.
    ids = (await resticSnapshots(session)).map((snap) => snap.id);
  }, 60_000);

  afterAll(async () => {
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("streams the changes between two restore points", async () => {
    const changes: unknown[] = [];
    await resticDiffLines(session, ids[1] as string, ids[0] as string, (line) => {
      const change = catalogChangeOf(line, root);
      if (change) changes.push(change);
    });
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: "a.txt", action: "both" },
        { path: "c.txt", action: "open" },
        { path: "sub/b.txt", action: "close" },
      ]),
    );
    expect(changes).toHaveLength(3);
  });

  it("streams every file of a restore point", async () => {
    const files: string[] = [];
    await resticLsLines(session, ids[0] as string, (line) => {
      const node = catalogNodeOf(line, root);
      if (node) files.push(node.path);
    });
    expect(files.sort()).toEqual(["a.txt", "c.txt"]);
  });

  it("refuses an id that could pass for an option", async () => {
    await expect(resticLsLines(session, "--help", () => undefined)).rejects.toThrow(TypeError);
  });

  it("passes restic's failure on", async () => {
    await expect(resticLsLines(session, "deadbeef", () => undefined)).rejects.toThrow(
      /restic ls failed/,
    );
  });
});
