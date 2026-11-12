import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalStorageBackend } from "../storage/local.js";
import { WriteOnceBackend } from "../storage/testing/write-once-backend.js";
import {
  chainNumberOf,
  chainRepositoryPrefix,
  defaultRepositoryPrefix,
  freshRepositoryPrefix,
  repositoryFolderOf,
  repositoryPrefixOf,
} from "./repository-prefix.js";

const GUEST = "0b5f2a9e-6f1c-4a51-9d6e-2f1d3c4b5a69";
const OTHER = "7a1c4e2b-0d9f-4b3a-8c5e-6f7a8b9c0d1e";

describe("repository prefixes", () => {
  it("keeps the default prefix until a chain under a fresh one is recorded", () => {
    expect(defaultRepositoryPrefix("container", GUEST)).toBe(`pve-guests/${GUEST}/`);
    expect(repositoryPrefixOf("container", GUEST, null)).toBe(`pve-guests/${GUEST}/`);
    expect(repositoryPrefixOf("file_share", GUEST, undefined)).toBe(`file-shares/${GUEST}/`);
    const fresh = chainRepositoryPrefix("container", GUEST, 2);
    expect(fresh).toBe(`pve-guests/${GUEST}.chain-2/`);
    expect(repositoryPrefixOf("container", GUEST, fresh)).toBe(fresh);
    expect(chainNumberOf("container", GUEST, fresh)).toBe(2);
    expect(chainNumberOf("container", GUEST, `pve-guests/${GUEST}/`)).toBe(1);
  });

  it("refuses a recorded prefix that is not the owner's own", () => {
    for (const recorded of [
      `pve-guests/${OTHER}/`,
      `pve-guests/${OTHER}.chain-2/`,
      `file-shares/${GUEST}.chain-2/`,
      `pve-guests/${GUEST}.chain-2`,
      `pve-guests/${GUEST}.chain-0/`,
      `pve-guests/${GUEST}.orphaned-2026-11-05T10-00-00-000Z/`,
      `pve-guests/${GUEST}/../${OTHER}/`,
    ]) {
      expect(() => repositoryPrefixOf("container", GUEST, recorded), recorded).toThrow();
    }
    expect(() => defaultRepositoryPrefix("container", "../etc")).toThrow();
    expect(() => chainRepositoryPrefix("container", GUEST, 1)).toThrow();
  });

  it("tells the folders of an owner apart", () => {
    expect(repositoryFolderOf(GUEST)).toEqual({ ownerId: GUEST, chain: 1, movedAside: false });
    expect(repositoryFolderOf(`${GUEST}.chain-3`)).toEqual({
      ownerId: GUEST,
      chain: 3,
      movedAside: false,
    });
    expect(repositoryFolderOf(`${GUEST}.orphaned-2026-11-05T10-00-00-000Z`)).toEqual({
      ownerId: GUEST,
      chain: null,
      movedAside: true,
    });
    // A chain under a fresh prefix that a reset or the repair moved aside.
    expect(repositoryFolderOf(`${GUEST}.chain-2.orphaned-2026-11-05T10-00-00-000Z`)).toEqual({
      ownerId: GUEST,
      chain: null,
      movedAside: true,
    });
    expect(repositoryFolderOf(`${GUEST}.something`)).toBeNull();
    expect(repositoryFolderOf(`${GUEST}.chain-0.orphaned-2026-11-05T10-00-00-000Z`)).toBeNull();
    expect(repositoryFolderOf(`${GUEST}.chain-2.other`)).toBeNull();
  });

  it("finds the first fresh prefix that holds nothing, without writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "restow-prefix-"));
    try {
      const worm = new WriteOnceBackend(new LocalStorageBackend(dir));
      await worm.put(`pve-guests/${GUEST}/data/00/aa`, Buffer.from("old"));
      expect(await freshRepositoryPrefix(worm, "container", GUEST, `pve-guests/${GUEST}/`)).toBe(
        `pve-guests/${GUEST}.chain-2/`,
      );
      // A chain-2 that already holds something (an attempt that never got recorded) is skipped.
      await worm.put(`pve-guests/${GUEST}.chain-2/config`, Buffer.from("x"));
      expect(await freshRepositoryPrefix(worm, "container", GUEST, `pve-guests/${GUEST}/`)).toBe(
        `pve-guests/${GUEST}.chain-3/`,
      );
      // From a recorded chain, the next one after it.
      expect(
        await freshRepositoryPrefix(worm, "container", GUEST, `pve-guests/${GUEST}.chain-4/`),
      ).toBe(`pve-guests/${GUEST}.chain-5/`);
      expect(worm.refused).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
