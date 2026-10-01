import { describe, expect, it } from "vitest";
import { redactAgentLog, redactAgentMessage } from "./run-redact.js";

const secret = `rsea_${"Zz9_-Yy8".repeat(5)}abc`;
const token = `rset_${"A1b2-C3d4_".repeat(4)}xyz`;

describe("redaction of what an agent reports", () => {
  it("removes credentials from a log and keeps its lines", () => {
    const log = [
      "2026-10-01T22:00:00Z INFO  Backup started.",
      `2026-10-01T22:00:01Z DEBUG pre hook: curl -u admin:${secret} https://db.internal/dump`,
      "2026-10-01T22:00:02Z DEBUG env RESTIC_PASSWORD=hunter2hunter2",
      `2026-10-01T22:00:03Z WARN  enrolled with ${token}`,
      "2026-10-01T22:00:04Z INFO  Files:          10 new,     2 changed",
    ].join("\n");
    const redacted = redactAgentLog(log);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain("hunter2hunter2");
    const lines = redacted.split("\n");
    expect(lines).toHaveLength(5);
    // A line with nothing to remove keeps its layout, spaces and all.
    expect(lines[0]).toBe("2026-10-01T22:00:00Z INFO  Backup started.");
    expect(lines[4]).toBe("2026-10-01T22:00:04Z INFO  Files:          10 new,     2 changed");
    expect(lines[3]).toContain("[redacted]");
  });

  it("removes key material that spans lines", () => {
    const log =
      "before\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nAAAA\n-----END PRIVATE KEY-----\nafter";
    const redacted = redactAgentLog(log);
    expect(redacted).not.toContain("MIIEvQ");
    expect(redacted.split("\n")).toEqual(["before", "[redacted]", "after"]);
  });

  it("handles an empty log and Windows line ends", () => {
    expect(redactAgentLog("")).toBe("");
    expect(redactAgentLog("a\r\nb")).toBe("a\nb");
  });

  it("redacts an error message onto one bounded line", () => {
    expect(redactAgentMessage(`pre hook failed: token=${secret}`, 1000)).toBe(
      "pre hook failed: token=[redacted]",
    );
    expect(redactAgentMessage("x".repeat(50), 10)).toHaveLength(10);
  });
});
