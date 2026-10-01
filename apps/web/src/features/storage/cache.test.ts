import { describe, expect, it } from "vitest";

import { removeTarget, upsertTarget } from "./cache";
import type { StorageTargetDto, StorageTargetList } from "./types";

const target = (id: string, role: "primary" | "copy", createdAt: string) =>
  ({ id, role, createdAt }) as StorageTargetDto;

const list = (items: StorageTargetDto[]): StorageTargetList => ({
  items,
  installationDefault: {
    inUse: false,
    kind: "local",
    location: null,
    hasCopy: false,
    copyLocation: null,
    misconfigured: false,
  },
  tenantHasData: true,
  canManageLocal: false,
});

describe("target cache", () => {
  it("keeps the primary first and copies by creation", () => {
    const next = upsertTarget(
      list([target("c2", "copy", "2026-09-02"), target("p", "primary", "2026-09-03")]),
      target("c1", "copy", "2026-09-01"),
    );
    expect(next.items.map((item) => item.id)).toEqual(["p", "c1", "c2"]);
  });

  it("replaces and removes", () => {
    const before = list([target("p", "primary", "2026-09-01")]);
    expect(upsertTarget(before, target("p", "copy", "2026-09-01")).items[0]?.role).toBe("copy");
    expect(removeTarget(before, "p").items).toEqual([]);
  });
});
