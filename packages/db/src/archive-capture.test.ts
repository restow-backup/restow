/**
 * Capture kinds and capture ways (archive-capture.ts). The SQL form is checked against the
 * function on the same cases when RESTOW_TEST_DATABASE_URL points at a Postgres server.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  type CaptureKindInput,
  captureChoicePending,
  captureKindOf,
  captureKindSql,
  effectiveArchiveCapture,
  kindsWithoutWay,
  mailboxCaptureWay,
  withPendingMarkers,
} from "./archive-capture.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;

const CASES: [CaptureKindInput, ReturnType<typeof captureKindOf>][] = [
  [{ objectKind: "mailbox", sourceKind: "m365" }, "m365"],
  [{ objectKind: "onedrive", sourceKind: "m365" }, null],
  [{ objectKind: "site", sourceKind: "m365" }, null],
  [{ objectKind: "imap", sourceKind: "imap", host: "mail.example.net" }, "imap"],
  [{ objectKind: "imap", sourceKind: "imap", host: " IMAP.Gmail.com. " }, "google"],
  [{ objectKind: "imap", sourceKind: "imap", host: "imap.googlemail.com" }, "google"],
  [
    {
      objectKind: "imap",
      sourceKind: "imap",
      host: "mail.example.net",
      config: { authKind: "oauth2", oauth2Provider: "google" },
    },
    "google",
  ],
  [
    {
      objectKind: "imap",
      sourceKind: "imap",
      host: "mail.example.net",
      config: { authKind: "password", oauth2Provider: "google" },
    },
    "imap",
  ],
  [{ objectKind: "imap", sourceKind: "imap", host: "outlook.office365.com" }, "imap_microsoft"],
  [{ objectKind: "imap", sourceKind: "imap", host: "imap-mail.outlook.com" }, "imap_microsoft"],
  // Imported mailboxes have nothing to capture.
  [{ objectKind: "imap", sourceKind: "import" }, null],
];

describe("captureKindOf", () => {
  for (const [input, expected] of CASES) {
    it(`${input.objectKind}/${input.sourceKind}/${input.host ?? "-"} -> ${expected}`, () => {
      expect(captureKindOf(input)).toBe(expected);
    });
  }
});

describe.skipIf(!adminUrl)("captureKindSql", () => {
  it("decides as captureKindOf does", async () => {
    const pool = new pg.Pool({ connectionString: adminUrl });
    try {
      const db = drizzle(pool);
      for (const [input, expected] of CASES) {
        const result = await db.execute<{ kind: string | null }>(sql`
          select ${captureKindSql("po", "s")} as kind
            from (select ${input.objectKind}::text as kind) po,
                 (select ${input.sourceKind}::text as kind, ${input.host ?? null}::text as host,
                         ${JSON.stringify(input.config ?? {})}::jsonb as config) s
        `);
        expect(result.rows[0]?.kind ?? null, JSON.stringify(input)).toBe(expected);
      }
    } finally {
      await pool.end();
    }
  });
});

describe("capture ways", () => {
  it("fills in the defaults for kinds a job does not mention", () => {
    expect(effectiveArchiveCapture({ m365: { graph: false, journal: true } })).toEqual({
      m365: { graph: false, journal: true },
      imap: { sync: true, forward: false },
      google: { sync: true, forward: false },
    });
  });

  it("names the mailbox way of a kind, if chosen", () => {
    expect(mailboxCaptureWay("m365", {})).toBe("graph_sync");
    expect(mailboxCaptureWay("m365", { m365: { graph: false, journal: true } })).toBeNull();
    expect(mailboxCaptureWay("imap_microsoft", {})).toBe("imap_sync");
    expect(mailboxCaptureWay("google", { google: { sync: false, forward: true } })).toBeNull();
    expect(mailboxCaptureWay("google", { imap: { sync: false, forward: true } })).toBe("imap_sync");
  });

  it("finds the kinds without any way", () => {
    const settings = {
      m365: { graph: false, journal: false },
      google: { sync: false, forward: true },
      imap: { sync: false, forward: false },
    };
    expect(kindsWithoutWay(settings, ["m365", "google", "imap", "imap_microsoft", "m365"])).toEqual(
      ["m365", "imap", "imap_microsoft"],
    );
    expect(kindsWithoutWay(settings, [])).toEqual([]);
  });

  it("lets a kind wait for its first way after the update to 0.4.4 (pending), and no other", () => {
    const migrated = {
      m365: { graph: false, journal: true },
      imap: { sync: false, forward: false, pending: true as const },
      google: { sync: false, forward: false, pending: true as const },
    };
    expect(kindsWithoutWay(migrated, ["m365", "imap", "imap_microsoft", "google"])).toEqual([]);
    expect(captureChoicePending(migrated, "imap_microsoft")).toBe(true);
    expect(captureChoicePending(migrated, "google")).toBe(true);
    expect(captureChoicePending(migrated, "m365")).toBe(false);
    // Nothing is captured from the mailboxes of such a job.
    expect(mailboxCaptureWay("imap", migrated)).toBeNull();
    expect(mailboxCaptureWay("google", migrated)).toBeNull();
    expect(mailboxCaptureWay("m365", migrated)).toBeNull();
    // A way chosen ends the wait: the marker no longer covers a kind without a way.
    const chosen = { ...migrated, imap: { sync: true, forward: false, pending: true as const } };
    expect(captureChoicePending(chosen, "imap")).toBe(false);
  });

  it("keeps the pending marker only where the job had it and there is still no way", () => {
    const before = { imap: { sync: false, forward: false, pending: true as const } };
    const waiting = { imap: { sync: false, forward: false, pending: true as const } };
    expect(withPendingMarkers(waiting, before)).toEqual(waiting);
    // Choosing a way clears it.
    expect(
      withPendingMarkers({ imap: { sync: false, forward: true, pending: true } }, before),
    ).toEqual({ imap: { sync: false, forward: true } });
    // Nobody sets it: not on a new job, not on a kind that did not have it.
    expect(withPendingMarkers(waiting, null)).toEqual({ imap: { sync: false, forward: false } });
    expect(
      withPendingMarkers({ google: { sync: false, forward: false, pending: true } }, before),
    ).toEqual({
      google: { sync: false, forward: false },
    });
    expect(withPendingMarkers({ m365: { graph: true, journal: false } }, before)).toEqual({
      m365: { graph: true, journal: false },
    });
  });
});
