import { describe, expect, it } from "vitest";
import {
  RESTIC_TYPES,
  type ResticAction,
  type ResticResource,
  actionOf,
  authorizeResticAction,
  needsExistenceCheck,
  needsLockOwnership,
  parseResticPath,
} from "./restic-authz.js";

const NAME = "a".repeat(64);
const object = (type: (typeof RESTIC_TYPES)[number]): ResticResource => ({
  kind: "object",
  type,
  name: NAME,
});

describe("parsing restic REST paths", () => {
  it("knows the repository, the config, lists and objects", () => {
    expect(parseResticPath("/")).toEqual({ kind: "repository" });
    expect(parseResticPath("")).toEqual({ kind: "repository" });
    expect(parseResticPath("/config")).toEqual({ kind: "config" });
    expect(parseResticPath("/data/")).toEqual({ kind: "list", type: "data" });
    expect(parseResticPath("/snapshots")).toEqual({ kind: "list", type: "snapshots" });
    expect(parseResticPath(`/keys/${NAME}`)).toEqual({ kind: "object", type: "keys", name: NAME });
  });

  it("refuses unknown types, names that are not a SHA-256 and anything that could climb out", () => {
    for (const path of [
      "/other/",
      `/data/${"g".repeat(64)}`,
      `/data/${"a".repeat(63)}`,
      `/data/${"A".repeat(64)}`,
      "/data/../config",
      `/data/ab/${NAME}`,
      `/data/${NAME}/extra`,
      "/../etc/passwd",
      "//config/x",
    ]) {
      expect(parseResticPath(path), path).toBeNull();
    }
  });
});

describe("mapping methods to actions", () => {
  it("maps the verbs of the protocol", () => {
    expect(actionOf("HEAD", object("data"))).toBe("head");
    expect(actionOf("GET", object("data"))).toBe("read");
    expect(actionOf("POST", object("data"))).toBe("write");
    expect(actionOf("DELETE", object("data"))).toBe("delete");
    expect(actionOf("GET", { kind: "list", type: "data" })).toBe("list");
    expect(actionOf("POST", { kind: "repository" })).toBe("create");
    expect(actionOf("DELETE", { kind: "repository" })).toBe("delete");
    expect(actionOf("POST", { kind: "config" })).toBe("write");
    expect(actionOf("PUT", object("data"))).toBeNull();
    expect(actionOf("POST", { kind: "list", type: "data" })).toBeNull();
    expect(actionOf("GET", { kind: "repository" })).toBeNull();
  });
});

describe("the append-only authorization matrix", () => {
  const cases: {
    action: ResticAction;
    resource: ResticResource;
    exists: boolean;
    agent: boolean;
    ownLock?: boolean;
  }[] = [];
  for (const type of RESTIC_TYPES) {
    cases.push({ action: "list", resource: { kind: "list", type }, exists: false, agent: true });
    cases.push({ action: "head", resource: object(type), exists: true, agent: true });
    cases.push({ action: "read", resource: object(type), exists: true, agent: true });
    // A new object may be added, an existing one never overwritten.
    cases.push({ action: "write", resource: object(type), exists: false, agent: true });
    cases.push({ action: "write", resource: object(type), exists: true, agent: false });
    // Only locks can be removed, and only the ones the agent wrote itself.
    cases.push({
      action: "delete",
      resource: object(type),
      exists: true,
      agent: type === "locks",
      ownLock: true,
    });
    cases.push({
      action: "delete",
      resource: object(type),
      exists: true,
      agent: false,
      ownLock: false,
    });
  }
  cases.push({ action: "head", resource: { kind: "config" }, exists: true, agent: true });
  cases.push({ action: "read", resource: { kind: "config" }, exists: true, agent: true });
  cases.push({ action: "write", resource: { kind: "config" }, exists: false, agent: false });
  cases.push({ action: "write", resource: { kind: "config" }, exists: true, agent: false });
  cases.push({ action: "delete", resource: { kind: "config" }, exists: true, agent: false });
  cases.push({ action: "create", resource: { kind: "repository" }, exists: false, agent: false });
  cases.push({ action: "delete", resource: { kind: "repository" }, exists: true, agent: false });

  for (const { action, resource, exists, agent, ownLock } of cases) {
    const owner = ownLock === undefined ? "" : ownLock ? " (own lock)" : " (foreign lock)";
    const label = `${action} ${resource.kind}${"type" in resource ? `:${resource.type}` : ""}${exists ? " (exists)" : ""}${owner}`;
    it(`agent: ${label} is ${agent ? "allowed" : "refused"}`, () => {
      expect(authorizeResticAction("agent", action, resource, exists, ownLock).allowed).toBe(agent);
    });
    it(`maintenance: ${label} is allowed`, () => {
      expect(authorizeResticAction("maintenance", action, resource, exists, ownLock).allowed).toBe(
        true,
      );
    });
  }

  it("says why an agent is refused", () => {
    expect(authorizeResticAction("agent", "write", object("data"), true)).toEqual({
      allowed: false,
      reason: "exists",
    });
    expect(authorizeResticAction("agent", "delete", object("snapshots"), true)).toEqual({
      allowed: false,
      reason: "not_allowed",
    });
    expect(authorizeResticAction("agent", "write", { kind: "config" }, false)).toEqual({
      allowed: false,
      reason: "read_only_type",
    });
    // A lock the agent did not write, such as the server's exclusive prune lock.
    expect(authorizeResticAction("agent", "delete", object("locks"), true)).toEqual({
      allowed: false,
      reason: "foreign_lock",
    });
  });

  it("only asks who wrote a lock when an agent wants to delete it", () => {
    expect(needsLockOwnership("agent", "delete", object("locks"))).toBe(true);
    expect(needsLockOwnership("agent", "delete", object("data"))).toBe(false);
    expect(needsLockOwnership("agent", "write", object("locks"))).toBe(false);
    expect(needsLockOwnership("maintenance", "delete", object("locks"))).toBe(false);
  });

  it("only asks whether an object exists for an agent's write", () => {
    expect(needsExistenceCheck("agent", "write")).toBe(true);
    expect(needsExistenceCheck("agent", "read")).toBe(false);
    expect(needsExistenceCheck("maintenance", "write")).toBe(false);
  });
});
