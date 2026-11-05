import { describe, expect, it } from "vitest";
import {
  redactAgentLog,
  redactAgentMessage,
  redactRecoveryLogBatch,
  redactRecoveryLogLines,
  stripAnsi,
} from "./run-redact.js";

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

describe("recovery logs (docs/BAREMETAL.md 9.8)", () => {
  it("strips escape sequences and C1 controls and keeps the text", () => {
    expect(stripAnsi("\u001b[1;31mERROR\u001b[0m disk \u001b]0;title\u0007gone\u009b")).toBe(
      "ERROR disk gone",
    );
    expect(stripAnsi("plain")).toBe("plain");
  });

  it("stores each line without control characters and without credentials", () => {
    const hex = "2a8abfa8cb9906290437854193ca6bca41d4d4e26d1d454bd66a35158095e737";
    const lines = redactRecoveryLogLines([
      "\u001b[32mrestoring\u001b[0m /home\tok",
      "code RC-7K3QX-M9P2D-H4TNV-8WRBC-J6FAS accepted",
      `sessionSecretSha256=${hex}`,
      `rebind with ${token}`,
      "bell\u0007 and\r return",
    ]);
    expect(lines[0]).toBe("restoring /home ok");
    expect(lines[1]).toBe("code [redacted] accepted");
    expect(lines[2]).not.toContain(hex);
    expect(lines[3]).not.toContain(token);
    expect(lines[4]).toBe("bell and return");
    expect(lines).toHaveLength(5);
  });

  it("masks a key block over several lines and several batches", () => {
    const body = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
    const lines = redactRecoveryLogLines([
      "echo key:",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      body,
      "-----END OPENSSH PRIVATE KEY----- done",
      "after",
    ]);
    expect(lines).toEqual(["echo key:", "[redacted]", "[redacted]", "[redacted] done", "after"]);
    expect(lines.join("\n")).not.toContain(body);
    // A block the ISO split across two log calls.
    const first = redactRecoveryLogBatch([
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0B",
    ]);
    expect(first).toEqual({ lines: ["[redacted]", "[redacted]"], inKeyBlock: true });
    const second = redactRecoveryLogBatch(
      ["AAAAB3NzaC1yc2EAAAADAQAB", "-----END PRIVATE KEY-----", "next"],
      first.inKeyBlock,
    );
    expect(second).toEqual({ lines: ["[redacted]", "[redacted]", "next"], inKeyBlock: false });
    // A block on one line closes itself.
    expect(
      redactRecoveryLogBatch([
        "x -----BEGIN RSA PRIVATE KEY-----abc-----END RSA PRIVATE KEY----- y",
      ]),
    ).toEqual({ lines: ["x [redacted] y"], inKeyBlock: false });
  });
});
