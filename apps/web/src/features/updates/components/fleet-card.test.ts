import { describe, expect, it } from "vitest";

import { manualCommand, olderThan } from "./fleet-card";

const COMMANDS = {
  pve_node: "/opt/restow-pve/bin/restow-pve update",
  linux: "sudo '/opt/restow-agent/bin/restow-agent' update",
  darwin: "sudo '/Library/Application Support/Restow/bin/restow-agent' update",
  legacy: {
    linux: "sudo systemctl restart restow-agent",
    darwin: "sudo launchctl kickstart -k system/com.restowbackup.agent",
  },
  agentUpdateSince: "0.4.2",
};

describe("the command for an update by hand", () => {
  it("is restow-pve update on a node", () => {
    expect(manualCommand(COMMANDS, { kind: "pve_node", os: null, version: "0.4.0" })).toEqual({
      command: COMMANDS.pve_node,
      legacy: false,
    });
  });

  it("is restow-agent update on a machine whose agent has the command", () => {
    for (const version of ["0.4.2", "0.4.2-rc.1", "0.5.0", "1.0.0"]) {
      expect(manualCommand(COMMANDS, { kind: "agent", os: "linux", version })).toEqual({
        command: COMMANDS.linux,
        legacy: false,
      });
    }
    expect(
      manualCommand(COMMANDS, { kind: "agent", os: "darwin", version: "0.4.3" })?.command,
    ).toBe(COMMANDS.darwin);
  });

  it("restarts the service of an agent before 0.4.2, or of one whose version is unknown", () => {
    expect(manualCommand(COMMANDS, { kind: "agent", os: "linux", version: "0.4.1" })).toEqual({
      command: COMMANDS.legacy.linux,
      legacy: true,
    });
    expect(manualCommand(COMMANDS, { kind: "agent", os: "darwin", version: null })).toEqual({
      command: COMMANDS.legacy.darwin,
      legacy: true,
    });
  });

  it("keeps the command an older server names, and has none for another system", () => {
    const older = { pve_node: COMMANDS.pve_node, linux: "restart", darwin: "kickstart" };
    expect(manualCommand(older, { kind: "agent", os: "linux", version: "0.4.0" })).toEqual({
      command: "restart",
      legacy: false,
    });
    expect(manualCommand(COMMANDS, { kind: "agent", os: "windows", version: "0.4.2" })).toBeNull();
  });
});

describe("olderThan", () => {
  it("compares release versions", () => {
    expect(olderThan("0.4.1", "0.4.2")).toBe(true);
    expect(olderThan("0.3.9", "0.4.2")).toBe(true);
    expect(olderThan("0.4.2", "0.4.2")).toBe(false);
    expect(olderThan("0.10.0", "0.4.2")).toBe(false);
    expect(olderThan("dev", "0.4.2")).toBe(true);
  });
});
