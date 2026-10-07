import { describe, expect, it } from "vitest";

import type { Failure } from "@/features/failures/api";
import { ApiError } from "@/lib/api";
import { removeSource, upsertSource } from "./cache";
import {
  VERIFICATION_GRACE_MS,
  consentErrorMessage,
  describeConsentResult,
  describeSourceProblem,
  isAwaitingConsent,
  isAwaitingVerification,
  isCurrentConsentError,
  parseConsentSearch,
  problemField,
  retainedDataOf,
  sourceCause,
  sourceErrorKey,
  summarizeSource,
  syncProblem,
} from "./presenters";
import type { ConnectionVerification, ImapProbeResult, SourceDto } from "./types";

const allGranted = {
  checks: [],
  granted: ["Mail.ReadWrite"],
  missing: [],
  readOnlyInstead: [],
  unexpected: [],
  complete: true,
};

const green: ConnectionVerification = {
  checkedAt: "2026-09-22T10:05:00.000Z",
  tokenAcquired: true,
  tokenError: null,
  permissions: allGranted,
  testCall: { ok: true, usersSampled: 3, sample: [] },
  ok: true,
};

function m365(
  patch: Partial<NonNullable<SourceDto["m365"]>> = {},
  source: Partial<SourceDto> = {},
): SourceDto {
  return {
    id: "7d8e9f00-1111-2222-3333-444455556666",
    tenantId: "0b3f6b2e-9c2d-4c3a-9e7f-1d2c3b4a5f60",
    kind: "m365",
    name: "Contoso",
    status: "pending",
    errorMessage: null,
    failure: null,
    lastSyncAt: null,
    createdAt: "2026-09-22T09:00:00.000Z",
    updatedAt: "2026-09-22T09:00:00.000Z",
    m365: {
      connectionMode: "consent",
      ownApp: null,
      entraTenantId: null,
      entraTenantHint: null,
      consentGrantedAt: null,
      consentBy: null,
      consentError: null,
      permissions: null,
      verification: null,
      ...patch,
    },
    imap: null,
    ...source,
  };
}

function imap(lastProbe: ImapProbeResult | null, source: Partial<SourceDto> = {}): SourceDto {
  return {
    ...m365(),
    kind: "imap",
    name: "Alice",
    m365: null,
    imap: {
      host: "imap.example.com",
      port: 993,
      security: "tls",
      username: "alice",
      hasPassword: true,
      authKind: "password",
      lastProbe,
      imapAuthMode: "shared",
      masterUser: null,
    },
    ...source,
  };
}

const connected = {
  entraTenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  consentGrantedAt: "2026-09-22T10:00:00.000Z",
};
const failedProbe: ImapProbeResult = {
  ok: false,
  checkedAt: "2026-09-22T10:00:00.000Z",
  reason: "auth",
  code: null,
  message: "no",
};

describe("summarizeSource", () => {
  it("says what a Microsoft 365 source needs next", () => {
    expect(summarizeSource(m365()).key).toBe("list.consentPending");
    expect(
      summarizeSource(
        m365({ consentError: { error: "access_denied", description: null, at: "x" } }),
      ),
    ).toMatchObject({ key: "list.consentDeniedShort", tone: "destructive" });
    expect(summarizeSource(m365(connected)).key).toBe("list.notVerified");
    expect(summarizeSource(m365({ ...connected, verification: green }))).toMatchObject({
      key: "list.permissionsOk",
      tone: "ok",
    });
    const incomplete = {
      ...green,
      ok: false,
      permissions: {
        ...allGranted,
        missing: ["Mail.ReadWrite", "Group.Read.All"],
        complete: false,
      },
    };
    expect(summarizeSource(m365({ ...connected, verification: incomplete }))).toEqual({
      key: "list.permissionsIncomplete",
      values: { count: 2 },
      tone: "destructive",
    });
  });

  it("says what an IMAP source needs next", () => {
    expect(summarizeSource(imap(null)).key).toBe("list.imapNotTested");
    expect(summarizeSource(imap(failedProbe)).key).toBe("list.imapFailed");
  });

  it("puts a pause first", () => {
    expect(summarizeSource(imap(failedProbe, { status: "disabled" }))).toEqual({
      key: "list.paused",
      tone: "neutral",
    });
  });
});

describe("syncProblem", () => {
  it("shows a backup-run problem only when the check itself is not the cause", () => {
    const syncError = { status: "error" as const, errorMessage: "Delta token expired" };
    expect(syncProblem(m365({ ...connected, verification: green }, syncError))).toBe(
      "Delta token expired",
    );
    expect(
      syncProblem(m365({ ...connected, verification: { ...green, ok: false } }, syncError)),
    ).toBeNull();
    expect(syncProblem(imap(failedProbe, syncError))).toBeNull();
    expect(syncProblem(imap(null, { ...syncError, status: "active" }))).toBeNull();
  });
});

const consentMissing: Failure = {
  code: "graph.consent_missing",
  category: "microsoft",
  transient: false,
  retryable: true,
  params: {},
  technical: {},
  occurredAt: "2026-09-22T10:06:00.000Z",
  step: null,
  retry: null,
  steps: [{ id: "regrant_consent", target: "source" }],
  docsUrl: "https://docs.example.test/troubleshooting",
};

describe("describeSourceProblem", () => {
  const broken = { status: "error" as const, errorMessage: "Verification failed" };

  it("explains a classified cause and keeps the recorded message as a detail", () => {
    const source = m365(
      { ...connected, verification: { ...green, ok: false } },
      {
        ...broken,
        failure: consentMissing,
        lastSyncAt: "2026-09-22T09:30:00.000Z",
      },
    );
    expect(describeSourceProblem(source)).toEqual({
      kind: "classified",
      failure: consentMissing,
      message: "Verification failed",
      at: "2026-09-22T09:30:00.000Z",
    });
  });

  it("dates an explanation by the last update when the source never synced", () => {
    const source = m365(connected, { ...broken, failure: consentMissing });
    expect(describeSourceProblem(source)).toMatchObject({ at: source.updatedAt });
  });

  it("keeps the old rule for a source without a classified cause", () => {
    expect(describeSourceProblem(m365({ ...connected, verification: green }, broken))).toEqual({
      kind: "recorded",
      message: "Verification failed",
    });
    // The check panels already explain a failed check, so nothing is added.
    expect(
      describeSourceProblem(m365({ ...connected, verification: { ...green, ok: false } }, broken)),
    ).toBeNull();
  });

  it("says nothing about a source that is not in error", () => {
    expect(
      describeSourceProblem(m365(connected, { status: "active", failure: consentMissing })),
    ).toBeNull();
    expect(
      describeSourceProblem(m365(connected, { status: "disabled", failure: consentMissing })),
    ).toBeNull();
  });
});

describe("sourceCause", () => {
  it("returns the classified cause of a source in error only", () => {
    expect(sourceCause({ status: "error", failure: consentMissing })).toBe(consentMissing);
    expect(sourceCause({ status: "error", failure: null })).toBeNull();
    expect(sourceCause({ status: "active", failure: consentMissing })).toBeNull();
  });

  it("tolerates a response from a server that does not send causes yet", () => {
    const old = { status: "error" } as Pick<SourceDto, "status" | "failure">;
    expect(sourceCause(old)).toBeNull();
  });
});

describe("consent round trip", () => {
  it("parses search parameters field by field", () => {
    expect(
      parseConsentSearch({
        consent: "granted",
        verified: "ok",
        tenant: "0b3f6b2e-9c2d-4c3a-9e7f-1d2c3b4a5f60",
      }),
    ).toEqual({
      consent: "granted",
      verified: "ok",
      tenant: "0b3f6b2e-9c2d-4c3a-9e7f-1d2c3b4a5f60",
    });
    expect(
      parseConsentSearch({ consent: "hacked", tenant: "not-a-uuid", error: "access_denied" }),
    ).toEqual({
      error: "access_denied",
    });
    expect(parseConsentSearch({})).toEqual({});
  });

  it("describes every callback outcome", () => {
    expect(describeConsentResult({})).toBeNull();
    expect(describeConsentResult({ consent: "granted" })?.key).toBe("m365.consentResult.granted");
    expect(describeConsentResult({ consent: "granted", verified: "failed" })).toMatchObject({
      key: "m365.consentResult.grantedVerifiedFailed",
      tone: "warning",
    });
    expect(describeConsentResult({ consent: "denied", error: "access_denied" })).toEqual({
      key: "m365.consentResult.denied",
      values: { error: "access_denied" },
      tone: "destructive",
    });
    expect(describeConsentResult({ consent: "tenant_mismatch" })?.key).toBe(
      "m365.consentResult.tenant_mismatch",
    );
    expect(describeConsentResult({ consent: "invalid_state" })?.tone).toBe("destructive");
    expect(
      describeConsentResult(
        parseConsentSearch({ consent: "identity_not_verified", reason: "not_an_admin" }),
      ),
    ).toEqual({ key: "m365.consentResult.identity_not_verified", tone: "destructive" });
  });

  it("explains recorded consent errors", () => {
    expect(consentErrorMessage({ error: "tenant_mismatch", description: null, at: "x" })).toEqual({
      key: "m365.consentError.codes.tenant_mismatch",
    });
    for (const error of [
      "sign_in_failed",
      "identity_mismatch",
      "not_an_admin",
      "role_check_failed",
      "app_not_configured",
    ]) {
      expect(consentErrorMessage({ error, description: null, at: "x" })).toEqual({
        key: `m365.consentError.codes.${error}`,
      });
    }
    expect(consentErrorMessage({ error: "invalid_request", description: null, at: "x" })).toEqual({
      key: "m365.consentError.codes.other",
      values: { code: "invalid_request" },
    });
  });

  it("treats a failure older than the connecting consent as history", () => {
    const error = { error: "access_denied", description: null, at: "2026-09-22T09:00:00.000Z" };
    expect(isCurrentConsentError(error, null)).toBe(true);
    expect(isCurrentConsentError(error, "2026-09-22T10:00:00.000Z")).toBe(false);
    expect(
      isCurrentConsentError(
        { ...error, at: "2026-09-22T11:00:00.000Z" },
        "2026-09-22T10:00:00.000Z",
      ),
    ).toBe(true);
    expect(isCurrentConsentError(null, null)).toBe(false);
  });

  it("knows when it waits for consent and for the callback's verification", () => {
    expect(isAwaitingConsent(m365())).toBe(true);
    expect(isAwaitingConsent(m365(connected))).toBe(false);
    expect(isAwaitingConsent(imap(null))).toBe(false);

    const granted = Date.parse(connected.consentGrantedAt);
    expect(isAwaitingVerification(m365(connected), granted + 5_000)).toBe(true);
    expect(
      isAwaitingVerification(m365({ ...connected, verification: green }), granted + 5_000),
    ).toBe(false);
    const stale = { ...green, checkedAt: "2026-09-21T10:00:00.000Z" };
    expect(
      isAwaitingVerification(m365({ ...connected, verification: stale }), granted + 5_000),
    ).toBe(true);
    expect(isAwaitingVerification(m365(connected), granted + VERIFICATION_GRACE_MS + 1)).toBe(
      false,
    );
    expect(isAwaitingVerification(m365(), granted)).toBe(false);
  });
});

describe("API problems", () => {
  const problem = (type: string, extra: Record<string, unknown> = {}) =>
    new ApiError(409, { type, title: "x", status: 409, ...extra }, "x");

  it("maps feature problem types to feature messages, everything else to common ones", () => {
    expect(sourceErrorKey(problem("urn:restow:problem:source-name-taken"))).toBe(
      "sources:errors.nameTaken",
    );
    expect(sourceErrorKey(problem("urn:restow:problem:password-required"))).toBe(
      "sources:errors.passwordRequired",
    );
    expect(sourceErrorKey(problem("urn:restow:problem:imap-host-not-allowed"))).toBe(
      "sources:errors.imapHostNotAllowed",
    );
    expect(sourceErrorKey(problem("about:blank"))).toBe("common:errors.conflict");
    expect(sourceErrorKey(new Error("boom"))).toBe("common:errors.generic");
  });

  it("reads the field a problem belongs to", () => {
    expect(problemField(problem("urn:restow:problem:source-name-taken", { field: "name" }))).toBe(
      "name",
    );
    expect(problemField(problem("about:blank"))).toBeNull();
  });

  it("reads what blocked a delete", () => {
    expect(
      retainedDataOf(
        problem("urn:restow:problem:source-has-data", {
          retained: { snapshots: 12, archiveItems: 0, legalHolds: "x" },
        }),
      ),
    ).toEqual({ snapshots: 12, archiveItems: 0, legalHolds: 0 });
    expect(retainedDataOf(problem("about:blank"))).toBeNull();
    expect(retainedDataOf(null)).toBeNull();
  });
});

describe("cache helpers", () => {
  const a = { ...imap(null), id: "a", name: "Alpha" };
  const b = { ...imap(null), id: "b", name: "Bravo" };

  it("inserts in name order and replaces by id", () => {
    expect(upsertSource([b], a).map((s) => s.id)).toEqual(["a", "b"]);
    const renamed = { ...a, name: "Zulu" };
    expect(upsertSource([a, b], renamed).map((s) => s.name)).toEqual(["Bravo", "Zulu"]);
  });

  it("removes by id", () => {
    expect(removeSource([a, b], "a")).toEqual([b]);
  });
});
