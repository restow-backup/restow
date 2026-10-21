import { describe, expect, it } from "vitest";

import { nodeVersion } from "./nodes-table";

const base = { helperVersion: "0.4.2", updateVersion: null, updateRequestedAt: null };

describe("nodeVersion", () => {
  it("offers the server's release when the API says the node is outdated", () => {
    expect(
      nodeVersion({ ...base, updateVersion: "0.4.3", offeredVersion: "0.4.3", outdated: true }),
    ).toEqual({ version: "0.4.2", outdated: true, update: "0.4.3", updating: false });
  });

  it("offers nothing when the node is up to date", () => {
    expect(
      nodeVersion({ ...base, helperVersion: "0.4.3", offeredVersion: "0.4.3", outdated: false }),
    ).toEqual({ version: "0.4.3", outdated: false, update: null, updating: false });
  });

  it("says an update is pending once it was asked for", () => {
    const version = nodeVersion({
      ...base,
      updateVersion: "0.4.3",
      updateRequestedAt: "2026-10-22T08:00:00.000Z",
      offeredVersion: "0.4.3",
      outdated: true,
    });
    expect(version.updating).toBe(true);
  });

  it("follows updateVersion on a server older than 0.4.3", () => {
    expect(nodeVersion({ ...base, updateVersion: "0.4.2" }).update).toBe("0.4.2");
    expect(nodeVersion(base)).toEqual({
      version: "0.4.2",
      outdated: false,
      update: null,
      updating: false,
    });
  });
});
