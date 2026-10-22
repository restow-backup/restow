import { describe, expect, it } from "vitest";
import { holdCheckCommands } from "./hold-checks.js";

describe("hold check commands", () => {
  it("only connect and read, with unique ids", () => {
    const commands = holdCheckCommands();
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length);
    for (const { command } of commands) {
      for (const step of command.split("|").map((part) => part.trim())) {
        expect(step, command).toMatch(
          /^(Connect-ExchangeOnline|Connect-IPPSSession|Get-|Select-Object|Where-Object)/,
        );
      }
    }
    expect(commands.map((c) => c.command).join("\n")).toContain("LitigationHoldEnabled");
    expect(commands.some((c) => c.command.startsWith("Get-RetentionCompliancePolicy"))).toBe(true);
    // Security & Compliance commands come after their connect.
    const connect = commands.findIndex((c) => c.id === "connect_compliance");
    expect(
      commands.filter((c) => c.shell === "compliance").every((c) => commands.indexOf(c) >= connect),
    ).toBe(true);
  });
});
