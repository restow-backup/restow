import { describe, expect, it } from "vitest";
import { batchEnvelope, createFakeGraph, graphError } from "../graph/testing/fake-graph.js";
import { confirmObjectLocked, lockProbeRequest, recheckLocked } from "./locks.js";

const LOCKED = {
  status: 423,
  body: {
    error: {
      code: "notAllowed",
      message:
        "Access to this site has been blocked. Please contact the administrator to resolve this problem.",
      innerError: { code: "resourceLocked" },
    },
  },
};

function graph(answers: Record<string, { status: number; body?: unknown }>) {
  return createFakeGraph([
    {
      method: "POST",
      url: "/v1.0/$batch",
      respond: (call) =>
        batchEnvelope(call, (sub) => answers[sub.url] ?? { status: 404, body: graphError("x") }),
    },
  ]);
}

describe("lock probes", () => {
  it("read the drive root or the site's default library root, id only", () => {
    expect(lockProbeRequest("onedrive", "b!x").url).toBe("/drives/b!x/root?$select=id");
    expect(lockProbeRequest("site", "host,1,2").url).toBe(
      "/sites/host%2C1%2C2/drive/root?$select=id",
    );
  });

  it("unlock on 200, stay locked on the lock answer, and report anything else", async () => {
    const fake = graph({
      "/drives/a/root?$select=id": LOCKED,
      "/drives/b/root?$select=id": { status: 200, body: { id: "root" } },
      "/sites/s/drive/root?$select=id": LOCKED,
      "/drives/c/root?$select=id": { status: 404, body: graphError("itemNotFound") },
    });
    const failures: string[] = [];
    const states = await recheckLocked(
      fake.client(),
      [
        { kind: "onedrive", externalId: "a" },
        { kind: "onedrive", externalId: "b" },
        { kind: "site", externalId: "s" },
        { kind: "onedrive", externalId: "c" },
      ],
      (failure) => failures.push(`${failure.target.externalId}:${failure.response.status}`),
    );
    expect([...states]).toEqual([
      ["a", "locked"],
      ["b", "unlocked"],
      ["s", "locked"],
    ]);
    expect(failures).toEqual(["c:404"]);
  });

  it("confirm a lock at backup time only on the lock answer", async () => {
    const fake = graph({
      "/drives/a/root?$select=id": LOCKED,
      "/drives/b/root?$select=id": { status: 200, body: { id: "root" } },
    });
    expect(await confirmObjectLocked(fake.client(), "onedrive", "a")).toBe(true);
    expect(await confirmObjectLocked(fake.client(), "onedrive", "b")).toBe(false);
    expect(await confirmObjectLocked(fake.client(), "onedrive", "c")).toBeNull();
    const broken = createFakeGraph([
      { method: "POST", url: "/v1.0/$batch", respond: { status: 500, json: graphError("boom") } },
    ]);
    expect(await confirmObjectLocked(broken.client({ maxRetries: 0 }), "onedrive", "a")).toBeNull();
  });
});
