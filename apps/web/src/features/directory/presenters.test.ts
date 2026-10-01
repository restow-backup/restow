import { describe, expect, it } from "vitest";

import type { Failure } from "@/features/failures/api";
import { ApiError } from "@/lib/api";

import {
  CREDENTIAL_VARIANT,
  HEALTH_VARIANT,
  READINESS_VARIANT,
  STATUS_VARIANT,
  availableActions,
  backupFailure,
  backupState,
  canSetCredential,
  canTestCredentialLogin,
  credentialFailure,
  credentialProbeFailureKey,
  credentialView,
  describeSourceProblem,
  hasCredentialProblem,
  objectErrorKey,
  objectStatusView,
  objectSubtitle,
  objectTitle,
  pageCount,
  parseExclusionText,
  readinessView,
  rulesComplete,
  sameRules,
  sourceHealth,
  syncResultKey,
} from "./presenters";
import type { DirectorySource, ProtectedObject, ProtectionRules } from "./types";

function object(overrides: Partial<ProtectedObject> = {}): ProtectedObject {
  return {
    id: "o-1",
    sourceId: "s-1",
    sourceName: "Contoso",
    sourceKind: "m365",
    kind: "mailbox",
    origin: "directory_sync",
    status: "active",
    externalId: "user-1",
    displayName: "Alice Example",
    userId: "u-1",
    email: "alice@contoso.example",
    upn: "alice@contoso.example",
    sharedOrBlocked: false,
    override: null,
    notSelected: false,
    lastBackupAt: null,
    snapshotCount: 0,
    latestBackupJob: null,
    readiness: null,
    credential: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function source(overrides: Partial<DirectorySource> = {}): DirectorySource {
  return {
    id: "s-1",
    name: "Contoso",
    kind: "m365",
    status: "active",
    errorMessage: null,
    failure: null,
    lastSyncAt: null,
    consentGranted: true,
    rules: null,
    overrideCount: 0,
    sync: { lastRun: null, lastFullSyncAt: null, fullSyncPending: false, pendingJob: null },
    imapAuthMode: null,
    counts: { total: 0, active: 0, excluded: 0, orphaned: 0, mailbox: 0, onedrive: 0, imap: 0 },
    ...overrides,
  };
}

const rules: ProtectionRules = {
  mode: "all",
  groupId: null,
  groupName: null,
  exclude: [],
  includeSharedMailboxes: true,
};

describe("object labels", () => {
  it("prefers the name and shows the address or login only when it adds something", () => {
    expect(objectTitle(object())).toBe("Alice Example");
    expect(objectSubtitle(object())).toBe("alice@contoso.example");
    expect(objectTitle(object({ displayName: null }))).toBe("alice@contoso.example");
    expect(objectSubtitle(object({ displayName: null }))).toBeNull();
    expect(
      objectSubtitle(
        object({ kind: "imap", sourceKind: "imap", externalId: "alice", email: "a@x.y" }),
      ),
    ).toBe("alice");
  });
});

describe("backupState", () => {
  it("shows a failed latest run even when an older snapshot exists", () => {
    expect(
      backupState(
        object({
          lastBackupAt: "2026-09-20T00:00:00.000Z",
          latestBackupJob: {
            id: "j",
            status: "failed",
            at: "2026-09-22T00:00:00.000Z",
            failure: null,
          },
        }),
      ),
    ).toEqual({ kind: "failed", at: "2026-09-22T00:00:00.000Z" });
  });

  it("reports running, done and never", () => {
    expect(
      backupState(
        object({
          latestBackupJob: { id: "j", status: "active", at: "2026-09-22T00:00:00Z", failure: null },
        }),
      ),
    ).toEqual({ kind: "running" });
    expect(backupState(object({ lastBackupAt: "2026-09-22T00:00:00Z" }))).toEqual({
      kind: "done",
      at: "2026-09-22T00:00:00Z",
    });
    expect(backupState(object())).toEqual({ kind: "never" });
  });
});

/** A per_mailbox IMAP object, credential state overridable, for the credential-problem cases below. */
function perMailboxObject(
  overrides: Partial<ProtectedObject> = {},
  credentialOverrides: { hasPassword?: boolean; status?: "untested" | "ok" | "failed" | null } = {},
): ProtectedObject {
  return object({
    kind: "imap",
    credential: {
      authMode: "per_mailbox",
      hasPassword: true,
      status: "ok",
      checkedAt: null,
      error: null,
      errorReason: null,
      failure: null,
      ...credentialOverrides,
    },
    ...overrides,
  });
}

describe("hasCredentialProblem", () => {
  it("is true only for a per_mailbox account with no password, or a failed one", () => {
    expect(hasCredentialProblem(perMailboxObject())).toBe(false);
    expect(hasCredentialProblem(perMailboxObject({}, { hasPassword: false }))).toBe(true);
    expect(hasCredentialProblem(perMailboxObject({}, { status: "failed" }))).toBe(true);
    expect(hasCredentialProblem(perMailboxObject({}, { status: "untested" }))).toBe(false);
    // A shared/master_user account never has one of its own, whatever its status.
    expect(
      hasCredentialProblem(
        object({
          kind: "imap",
          credential: {
            authMode: "shared",
            hasPassword: false,
            status: "failed",
            checkedAt: null,
            error: null,
            errorReason: null,
            failure: null,
          },
        }),
      ),
    ).toBe(false);
    expect(hasCredentialProblem(object({ kind: "mailbox" }))).toBe(false);
  });
});

describe("objectStatusView", () => {
  it("shows the stored status, except not-selected instead of excluded", () => {
    // Protected is a state, not a proof: the neutral outline, never green.
    expect(objectStatusView(object())).toEqual({ variant: "outline", suffix: "active" });
    expect(objectStatusView(object({ status: "excluded" }))).toEqual({
      variant: "muted",
      suffix: "excluded",
    });
    expect(objectStatusView(object({ status: "excluded", notSelected: true }))).toEqual({
      variant: "muted",
      suffix: "not_selected",
    });
  });

  it("never shows a per_mailbox account as 'Protected' while it has no working password of its own", () => {
    // Regression: an `active` per_mailbox object with a missing or failed
    // credential still read as plain "Protected", the same as one that
    // actually backs up.
    expect(objectStatusView(perMailboxObject({}, { hasPassword: false }))).toEqual({
      variant: "warning",
      suffix: "needs_credential",
    });
    expect(objectStatusView(perMailboxObject({}, { status: "failed" }))).toEqual({
      variant: "warning",
      suffix: "needs_credential",
    });
    // Untested (a password is set, just not tried yet) is not a problem.
    expect(objectStatusView(perMailboxObject({}, { status: "untested" }))).toEqual({
      variant: "outline",
      suffix: "active",
    });
    // An excluded per_mailbox object with no password already reads as muted
    // "Excluded", so the downgrade only applies while `active`.
    expect(
      objectStatusView(perMailboxObject({ status: "excluded" }, { hasPassword: false })),
    ).toEqual({ variant: "muted", suffix: "excluded" });
  });
});

describe("readinessView", () => {
  it("never shows an unverified backup as fine", () => {
    expect(readinessView(object({ snapshotCount: 2 }))).toEqual({
      variant: "warning",
      key: "readiness.unverified",
    });
    expect(readinessView(object())).toEqual({ variant: "muted", key: "readiness.none" });
    expect(
      readinessView(object({ readiness: { rating: "red", checkedAt: "2026-09-22T00:00:00Z" } })),
    ).toEqual({ variant: "destructive", key: "readiness.red" });
  });

  it("never shows a per_mailbox account as ready while it has no working password of its own, even from an older verified restore point", () => {
    // Regression: a stale green readiness rating from before a source moved
    // to per_mailbox, or before a password stopped working, still showed
    // "Restore verified" for an object nothing can currently back up.
    const stillGreen = perMailboxObject(
      { readiness: { rating: "green", checkedAt: "2026-09-22T00:00:00Z" }, snapshotCount: 3 },
      { hasPassword: false },
    );
    expect(readinessView(stillGreen)).toEqual({
      variant: "warning",
      key: "readiness.needs_credential",
    });
    expect(readinessView(perMailboxObject({ snapshotCount: 3 }, { status: "failed" }))).toEqual({
      variant: "warning",
      key: "readiness.needs_credential",
    });
    // A working credential is unaffected: the ordinary readiness rating shows.
    expect(
      readinessView(
        perMailboxObject({ readiness: { rating: "green", checkedAt: "2026-09-22T00:00:00Z" } }),
      ),
    ).toEqual({ variant: "success", key: "readiness.green" });
  });
});

describe("credentialView", () => {
  it("is null for a non-IMAP object", () => {
    expect(credentialView(object({ kind: "mailbox" }))).toBeNull();
  });

  it("shows a per_mailbox account with no password as needing attention, never green", () => {
    expect(
      credentialView(
        object({
          kind: "imap",
          credential: {
            authMode: "per_mailbox",
            hasPassword: false,
            status: null,
            checkedAt: null,
            error: null,
            errorReason: null,
            failure: null,
          },
        }),
      ),
    ).toEqual({ variant: "warning", key: "credential.status.missing" });
  });

  it("shows an untested or failed per_mailbox credential distinctly from a working one", () => {
    const withPassword = (status: "untested" | "ok" | "failed" | null) =>
      object({
        kind: "imap",
        credential: {
          authMode: "per_mailbox",
          hasPassword: true,
          status,
          checkedAt: null,
          error: null,
          errorReason: null,
          failure: null,
        },
      });
    expect(credentialView(withPassword(null))).toEqual({
      variant: "muted",
      key: "credential.status.untested",
    });
    expect(credentialView(withPassword("untested"))).toEqual({
      variant: "muted",
      key: "credential.status.untested",
    });
    expect(credentialView(withPassword("failed"))).toEqual({
      variant: "destructive",
      key: "credential.status.failed",
    });
    // A working login is fine, not a restore proof: no green.
    expect(credentialView(withPassword("ok"))).toEqual({
      variant: "outline",
      key: "credential.status.ok",
    });
  });

  it("never shows a shared- or master_user-source account as missing a password, unlike per_mailbox", () => {
    // Regression: before authMode was exposed, every IMAP account without its
    // own secret_ref (every account on a shared or master_user source, i.e.
    // every pre-existing IMAP install) showed "Not protected" although it
    // backs up normally.
    const shared = object({
      kind: "imap",
      credential: {
        authMode: "shared",
        hasPassword: false,
        status: null,
        checkedAt: null,
        error: null,
        errorReason: null,
        failure: null,
      },
    });
    expect(credentialView(shared)).toBeNull();

    const masterUser = object({
      kind: "imap",
      credential: {
        authMode: "master_user",
        hasPassword: false,
        status: null,
        checkedAt: null,
        error: null,
        errorReason: null,
        failure: null,
      },
    });
    expect(credentialView(masterUser)).toBeNull();

    // Once a test login has run, the result still shows, whatever the mode.
    expect(
      credentialView({
        ...shared,
        credential: {
          authMode: "shared",
          hasPassword: false,
          status: "ok",
          checkedAt: null,
          error: null,
          errorReason: null,
          failure: null,
        },
      }),
    ).toEqual({ variant: "outline", key: "credential.status.ok" });
  });
});

describe("canSetCredential", () => {
  it("only offers Set password for per_mailbox accounts", () => {
    const per_mailbox = object({
      kind: "imap",
      credential: {
        authMode: "per_mailbox",
        hasPassword: false,
        status: null,
        checkedAt: null,
        error: null,
        errorReason: null,
        failure: null,
      },
    });
    expect(canSetCredential(per_mailbox)).toBe(true);

    const shared = object({
      kind: "imap",
      credential: {
        authMode: "shared",
        hasPassword: false,
        status: null,
        checkedAt: null,
        error: null,
        errorReason: null,
        failure: null,
      },
    });
    expect(canSetCredential(shared)).toBe(false);
    expect(canSetCredential(object({ kind: "mailbox" }))).toBe(false);
  });
});

describe("canTestCredentialLogin", () => {
  it("is false only for a per_mailbox account with no password yet", () => {
    expect(canTestCredentialLogin(perMailboxObject())).toBe(true);
    expect(canTestCredentialLogin(perMailboxObject({}, { hasPassword: false }))).toBe(false);
    // A failed test still has a password: the login exists, testing it again makes sense.
    expect(canTestCredentialLogin(perMailboxObject({}, { status: "failed" }))).toBe(true);
    // shared/master_user always have a login to test, from the source.
    expect(
      canTestCredentialLogin(
        object({
          kind: "imap",
          credential: {
            authMode: "shared",
            hasPassword: false,
            status: null,
            checkedAt: null,
            error: null,
            errorReason: null,
            failure: null,
          },
        }),
      ),
    ).toBe(true);
    expect(canTestCredentialLogin(object({ kind: "mailbox" }))).toBe(false);
  });
});

describe("objectErrorKey", () => {
  const problem = (type: string, extra: Record<string, unknown> = {}) =>
    new ApiError(409, { type, title: "x", status: 409, ...extra }, "x");

  it("maps the credential problems to directory messages, everything else to common ones", () => {
    expect(objectErrorKey(problem("urn:restow:problem:imap-not-per-mailbox"))).toBe(
      "directory:errors.imapNotPerMailbox",
    );
    expect(objectErrorKey(problem("urn:restow:problem:imap-credential-not-configured"))).toBe(
      "directory:errors.imapCredentialNotConfigured",
    );
    expect(objectErrorKey(problem("about:blank"))).toBe("common:errors.conflict");
    expect(objectErrorKey(new Error("boom"))).toBe("common:errors.generic");
  });
});

describe("credentialProbeFailureKey", () => {
  it("names the failed probe's reason", () => {
    expect(
      credentialProbeFailureKey({
        ok: false,
        checkedAt: "",
        reason: "auth",
        code: null,
        message: "",
      }),
    ).toBe("credential.probeReasons.auth");
  });
});

describe("availableActions", () => {
  it("offers the decisions that change something", () => {
    expect(availableActions(object())).toEqual({
      include: true,
      exclude: true,
      reset: false,
      remove: false,
    });
    expect(availableActions(object({ override: "exclude", status: "excluded" }))).toEqual({
      include: true,
      exclude: false,
      reset: true,
      remove: false,
    });
  });

  it("lets orphaned objects only return to the rules", () => {
    expect(availableActions(object({ status: "orphaned", override: "include" }))).toEqual({
      include: false,
      exclude: false,
      reset: true,
      remove: false,
    });
  });

  it("removes only manual accounts without backups", () => {
    const imap = object({ sourceKind: "imap", kind: "imap", origin: "manual", override: null });
    expect(availableActions(imap)).toEqual({
      include: false,
      exclude: true,
      reset: false,
      remove: true,
    });
    expect(availableActions({ ...imap, snapshotCount: 1 }).remove).toBe(false);
    expect(availableActions({ ...imap, status: "excluded" }).include).toBe(true);
  });
});

describe("parseExclusionText", () => {
  it("splits on lines, commas and semicolons and de-duplicates", () => {
    expect(parseExclusionText(" a@x.y \n\nB@x.y; b@x.y, c@x.y\n")).toEqual([
      "a@x.y",
      "B@x.y",
      "c@x.y",
    ]);
  });
});

describe("rules helpers", () => {
  it("requires a group in group mode; `selected` needs nothing more", () => {
    expect(rulesComplete(rules)).toBe(true);
    expect(rulesComplete({ ...rules, mode: "group" })).toBe(false);
    expect(rulesComplete({ ...rules, mode: "group", groupId: "g" })).toBe(true);
    expect(rulesComplete({ ...rules, mode: "selected" })).toBe(true);
  });

  it("compares rule sets the way the API stores them", () => {
    expect(sameRules(rules, { ...rules, exclude: [] })).toBe(true);
    expect(sameRules({ ...rules, exclude: ["A@x.y"] }, { ...rules, exclude: ["a@x.y"] })).toBe(
      true,
    );
    expect(sameRules(rules, { ...rules, includeSharedMailboxes: false })).toBe(false);
    expect(sameRules(rules, { ...rules, groupId: "ignored-in-all-mode" })).toBe(true);
  });
});

describe("syncResultKey", () => {
  it("names every outcome", () => {
    expect(syncResultKey({ status: "queued", jobId: "j" })).toBe("sync.result.queued");
    expect(syncResultKey({ status: "already_queued", jobId: null })).toBe(
      "sync.result.alreadyQueued",
    );
    expect(syncResultKey({ status: "not_queued", reason: "queue_unavailable" })).toBe(
      "sync.result.notQueued.queue_unavailable",
    );
  });
});

describe("sourceHealth", () => {
  it("orders the states by what the admin must act on", () => {
    expect(sourceHealth(source({ status: "disabled", consentGranted: false }))).toBe("disabled");
    expect(sourceHealth(source({ consentGranted: false }))).toBe("consent_outstanding");
    expect(
      sourceHealth(
        source({
          sync: {
            lastRun: null,
            lastFullSyncAt: null,
            fullSyncPending: false,
            pendingJob: { id: "j", status: "queued", startedAt: null, throttle: null },
          },
        }),
      ),
    ).toBe("syncing");
    expect(sourceHealth(source({ status: "error" }))).toBe("error");
    expect(sourceHealth(source())).toBe("never_synced");
    expect(sourceHealth(source({ kind: "imap", sync: null }))).toBe("manual");
  });
});

describe("pageCount", () => {
  it("is at least one", () => {
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(51, 25)).toBe(3);
  });
});

const cause: Failure = {
  code: "graph.permission_missing",
  category: "microsoft",
  transient: false,
  retryable: true,
  params: { permission: "User.Read.All" },
  technical: {},
  occurredAt: "2026-09-28T04:00:00.000Z",
  step: null,
  retry: null,
  steps: [{ id: "grant_permission", target: "source" }],
  docsUrl: "https://docs.example.test/troubleshooting",
};

const otherCause: Failure = { ...cause, code: "graph.throttled" };

function syncedSource(
  run: { ok: boolean; error?: string | null; failure?: Failure | null } | null,
  overrides: Partial<DirectorySource> = {},
): DirectorySource {
  return source({
    sync: {
      lastRun: run && {
        startedAt: "2026-09-28T03:59:00.000Z",
        finishedAt: "2026-09-28T04:00:00.000Z",
        ok: run.ok,
        mode: "incremental",
        counts: null,
        warnings: [],
        warningCount: 0,
        error: run.error ?? null,
        failure: run.failure ?? null,
      },
      lastFullSyncAt: null,
      fullSyncPending: false,
      pendingJob: null,
    },
    ...overrides,
  });
}

describe("describeSourceProblem", () => {
  it("prefers the cause of the failed run over the source's own", () => {
    const problem = describeSourceProblem(
      syncedSource(
        { ok: false, error: "403", failure: cause },
        { status: "error", failure: otherCause },
      ),
    );
    expect(problem).toEqual({
      kind: "sync",
      failure: cause,
      message: "403",
      at: "2026-09-28T04:00:00.000Z",
    });
  });

  it("falls back to the source's cause for a failed run that has none", () => {
    expect(
      describeSourceProblem(
        syncedSource({ ok: false, error: "403" }, { status: "error", failure: otherCause }),
      ),
    ).toMatchObject({ kind: "sync", failure: otherCause });
  });

  it("names a broken connection when the last run was fine or there was none", () => {
    expect(
      describeSourceProblem(
        syncedSource(
          { ok: true },
          { status: "error", failure: cause, errorMessage: "Verification failed" },
        ),
      ),
    ).toMatchObject({ kind: "source", failure: cause, message: "Verification failed" });
    expect(
      describeSourceProblem(syncedSource(null, { status: "error", failure: cause })),
    ).toMatchObject({ kind: "source" });
  });

  it("says nothing without a classified cause, so the card keeps its old text", () => {
    expect(describeSourceProblem(syncedSource({ ok: false, error: "403" }))).toBeNull();
    expect(describeSourceProblem(syncedSource({ ok: true }, { status: "error" }))).toBeNull();
    expect(describeSourceProblem(source())).toBeNull();
  });

  it("says nothing about a healthy source that still carries a cause", () => {
    expect(describeSourceProblem(syncedSource({ ok: true }, { failure: cause }))).toBeNull();
  });

  it("names the connection of an IMAP source, which has no sync", () => {
    expect(
      describeSourceProblem(source({ kind: "imap", sync: null, status: "error", failure: cause })),
    ).toMatchObject({ kind: "source", failure: cause });
  });
});

describe("backupFailure", () => {
  const job = (status: "failed" | "completed" | "active", failure: Failure | null) =>
    object({ latestBackupJob: { id: "j", status, at: "2026-09-28T04:00:00.000Z", failure } });

  it("returns the cause of a failed latest run only", () => {
    expect(backupFailure(job("failed", cause))).toBe(cause);
    expect(backupFailure(job("failed", null))).toBeNull();
    expect(backupFailure(job("completed", cause))).toBeNull();
    expect(backupFailure(job("active", cause))).toBeNull();
    expect(backupFailure(object())).toBeNull();
  });
});

describe("credentialFailure", () => {
  it("returns the cause of a failed login test only", () => {
    expect(credentialFailure(perMailboxObject({}, { status: "failed" }))).toBeNull();
    const failed = perMailboxObject({}, { status: "failed" });
    const withCause = {
      ...failed,
      credential: failed.credential && { ...failed.credential, failure: cause },
    };
    expect(credentialFailure(withCause)).toBe(cause);
    const working = {
      ...withCause,
      credential: withCause.credential && { ...withCause.credential, status: "ok" as const },
    };
    expect(credentialFailure(working)).toBeNull();
    expect(credentialFailure(object())).toBeNull();
  });
});

describe("where the badges are green", () => {
  // Green means proof (brand guide, section 4): a restore check that passed.
  // Everything else that is merely fine is the neutral outline.
  it("only the readiness of a passed restore check is a success", () => {
    expect(READINESS_VARIANT.green).toBe("success");
    const others = [
      ...Object.values(STATUS_VARIANT),
      ...Object.values(CREDENTIAL_VARIANT),
      ...Object.values(HEALTH_VARIANT),
      READINESS_VARIANT.yellow,
      READINESS_VARIANT.red,
    ];
    expect(others).not.toContain("success");
  });

  it("shows a protected object, a working login and a healthy source as neutral", () => {
    expect(STATUS_VARIANT.active).toBe("outline");
    expect(CREDENTIAL_VARIANT.ok).toBe("outline");
    expect(HEALTH_VARIANT.healthy).toBe("outline");
  });
});
