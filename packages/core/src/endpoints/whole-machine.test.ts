import { describe, expect, it } from "vitest";
import {
  agentVersionAtLeast,
  CONTAINER_IMAGE_EXCLUDES,
  DEFAULT_WHOLE_MACHINE_EXCLUDES,
  resolveFsSnapshot,
  wholeMachineApplies,
  wholeMachineNote,
} from "./whole-machine.js";

describe("whole machine backups", () => {
  it("excludes what a restored system does not need, and keeps container data", () => {
    expect(DEFAULT_WHOLE_MACHINE_EXCLUDES).toContain("/var/tmp/*");
    expect(DEFAULT_WHOLE_MACHINE_EXCLUDES).toContain("**/lost+found/*");
    expect(DEFAULT_WHOLE_MACHINE_EXCLUDES.some((e) => e.includes("docker"))).toBe(false);
    expect(DEFAULT_WHOLE_MACHINE_EXCLUDES).not.toContain("/var/cache");
    expect(CONTAINER_IMAGE_EXCLUDES).toEqual(["/var/lib/docker/btrfs", "/var/lib/docker/image"]);
  });

  it("applies to Linux machines that are no container", () => {
    expect(wholeMachineApplies("linux", "none")).toBe(true);
    expect(wholeMachineApplies("linux", "vm")).toBe(true);
    expect(wholeMachineApplies("linux", undefined)).toBe(true);
    expect(wholeMachineApplies("linux", "container")).toBe(false);
    expect(wholeMachineApplies("windows", "none")).toBe(false);
    expect(wholeMachineApplies("darwin", "none")).toBe(false);
  });

  it("notes why a member backs up its folders or what it should know", () => {
    const linux = { os: "linux", arch: "amd64", agentVersion: "0.5.0", virtualization: "none" };
    expect(wholeMachineNote(linux)).toBeNull();
    expect(wholeMachineNote({ ...linux, os: "windows" })).toBe("windows");
    expect(wholeMachineNote({ ...linux, os: "darwin" })).toBe("darwin_later");
    expect(wholeMachineNote({ ...linux, virtualization: "container" })).toBe("container");
    expect(wholeMachineNote({ ...linux, agentVersion: "0.4.12" })).toBe("agent_too_old");
    expect(wholeMachineNote({ ...linux, agentVersion: null })).toBe("agent_too_old");
    expect(wholeMachineNote({ ...linux, arch: "arm64" })).toBe("arm64_restore_later");
    expect(wholeMachineNote({ ...linux, layoutCodes: ["bios_needs_csm"] })).toBe("bios_needs_csm");
  });

  it("compares agent versions by their release", () => {
    expect(agentVersionAtLeast("0.5.0", "0.5.0")).toBe(true);
    expect(agentVersionAtLeast("0.5.0-rc.1", "0.5.0")).toBe(true);
    expect(agentVersionAtLeast("0.10.0", "0.5.0")).toBe(true);
    expect(agentVersionAtLeast("1.0.0", "0.5.0")).toBe(true);
    expect(agentVersionAtLeast("0.4.99", "0.5.0")).toBe(false);
    expect(agentVersionAtLeast("dev", "0.5.0")).toBe(false);
  });

  it("takes file system snapshots by default only for a whole machine", () => {
    expect(resolveFsSnapshot(undefined, true)).toBe("auto");
    expect(resolveFsSnapshot(null, false)).toBe("off");
    expect(resolveFsSnapshot("off", true)).toBe("off");
    expect(resolveFsSnapshot("auto", false)).toBe("auto");
  });
});
