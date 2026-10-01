import { describe, expect, it } from "vitest";
import type { ImapProbeResult } from "../sources/imap.js";
import { causeOfImapProbe } from "./probe.js";

function failed(
  reason: Extract<ImapProbeResult, { ok: false }>["reason"],
  code: string | null = null,
  message = "boom",
): ImapProbeResult {
  return { ok: false, checkedAt: "2026-09-29T10:00:00.000Z", reason, code, message };
}

const server = { host: "imap.example.test", port: 993 };

describe("causeOfImapProbe", () => {
  it("is null for a probe that worked", () => {
    expect(
      causeOfImapProbe(
        {
          ok: true,
          checkedAt: "2026-09-29T10:00:00.000Z",
          secure: true,
          server: null,
          mailboxes: 3,
          specialUse: [],
          capabilities: [],
        },
        server,
      ),
    ).toBeNull();
  });

  it("names each failure in the shared vocabulary, with the host", () => {
    const table: [Parameters<typeof failed>[0], string][] = [
      ["auth", "imap.auth_failed"],
      ["blocked_address", "imap.address_blocked"],
      ["starttls_unavailable", "imap.starttls_unavailable"],
      ["timeout", "network.timeout"],
      ["dns", "network.dns"],
      ["refused", "network.unreachable"],
      ["tls", "network.tls"],
      ["unknown", "unknown"],
    ];
    for (const [reason, code] of table) {
      const cause = causeOfImapProbe(failed(reason), server);
      expect(cause?.code, reason).toBe(code);
      if (code.startsWith("network.")) {
        expect(cause?.params).toMatchObject({ role: "imap", host: "imap.example.test", port: 993 });
      }
    }
  });

  it("tells a master-user login that cannot impersonate apart from a wrong password", () => {
    expect(causeOfImapProbe(failed("auth", "AUTHZID_UNSUPPORTED"), server)?.code).toBe(
      "imap.config_invalid",
    );
  });

  it("names the certificate problem", () => {
    expect(causeOfImapProbe(failed("tls", "CERT_HAS_EXPIRED"), server)?.params.reason).toBe(
      "expired",
    );
    expect(
      causeOfImapProbe(failed("tls", "DEPTH_ZERO_SELF_SIGNED_CERT"), server)?.params.reason,
    ).toBe("self_signed");
  });

  it("never carries a secret from the message", () => {
    const cause = causeOfImapProbe(
      failed("auth", null, "a LOGIN user@example.test hunter2hunter2 was refused"),
      server,
    );
    expect(JSON.stringify(cause)).not.toContain("hunter2hunter2");
  });
});
