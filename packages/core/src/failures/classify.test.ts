import { describe, expect, it } from "vitest";
import { OAuth2Error } from "../backup/imap/oauth2.js";
import { ImapAuthError, ImapConfigError, ImapSessionError } from "../backup/imap/types.js";
import {
  ChunkStoreFailedError,
  JobAbortedError,
  MissingChunkError,
  RestoreIntegrityError,
} from "../engine/chunkstore.js";
import { TokenAcquisitionError } from "../graph/auth/token.js";
import { GraphError } from "../graph/errors.js";
import { FailureError, classifyFailure } from "./classify.js";
import { graphResourceOf } from "./graph.js";

const BASE = "https://graph.microsoft.com/v1.0";

function graph(
  status: number,
  code: string,
  message: string,
  url: string,
  extra: { headers?: Record<string, string>; inner?: Record<string, string> } = {},
): GraphError {
  return new GraphError({
    status,
    method: "GET",
    url: `${BASE}${url}`,
    headers: extra.headers,
    payload: {
      error: {
        code,
        message,
        innerError: {
          date: "2026-09-29T08:12:01",
          "request-id": "6d3c1f0e-aaaa-4bbb-8ccc-0123456789ab",
          "client-request-id": "6d3c1f0e-aaaa-4bbb-8ccc-0123456789ab",
          ...extra.inner,
        },
      },
    },
  });
}

function withCode<T extends Error>(error: T, props: Record<string, unknown>): T {
  return Object.assign(error, props);
}

describe("graph resources", () => {
  it("names the permission each kind of request needs", () => {
    const table: [string, string, string | null][] = [
      ["/users/a@b.de/mailFolders?$top=10", "mail", "Mail.ReadWrite"],
      ["/users/a@b.de/messages/AAMk/$value", "mail", "Mail.ReadWrite"],
      ["/users/a@b.de/events", "calendar", "Calendars.ReadWrite"],
      ["/users/a@b.de/contactFolders", "contacts", "Contacts.ReadWrite"],
      ["/users/a@b.de/drive/root/delta", "onedrive", "Files.ReadWrite.All"],
      ["/drives/b!x/items/01ABC", "onedrive", "Files.ReadWrite.All"],
      ["/users/delta?$select=id", "users", "User.Read.All"],
      ["/users/a@b.de", "users", "User.Read.All"],
      ["/groups/123/transitiveMembers", "groups", "Group.Read.All"],
      ["/organization", "organization", "Organization.Read.All"],
      ["/$batch", "other", null],
    ];
    for (const [path, resource, permission] of table) {
      expect(graphResourceOf(`${BASE}${path}`), path).toEqual({ resource, permission });
    }
  });

  it("does not mistake a mailbox address that contains a resource word for that resource", () => {
    expect(graphResourceOf(`${BASE}/users/drive@corp.de/mailFolders`).resource).toBe("mail");
  });
});

describe("Microsoft Graph answers", () => {
  it("403 ErrorAccessDenied on a mailbox: access denied, naming the permission the call needs", () => {
    const cause = classifyFailure(
      graph(
        403,
        "ErrorAccessDenied",
        "Access is denied. Check credentials and try again.",
        "/users/a@b.de/mailFolders",
      ),
    );
    expect(cause.code).toBe("graph.access_denied");
    expect(cause.transient).toBe(false);
    expect(cause.params).toMatchObject({
      permission: "Mail.ReadWrite",
      httpStatus: 403,
      resource: "mail",
    });
    expect(cause.technical).toMatchObject({
      httpStatus: 403,
      errorCode: "ErrorAccessDenied",
      requestId: "6d3c1f0e-aaaa-4bbb-8ccc-0123456789ab",
      clientRequestId: "6d3c1f0e-aaaa-4bbb-8ccc-0123456789ab",
      serverDate: "2026-09-29T08:12:01",
      endpoint: "GET /v1.0/users/a@b.de/mailFolders",
    });
  });

  it("403 Authorization_RequestDenied on the directory: a missing permission", () => {
    const cause = classifyFailure(
      graph(
        403,
        "Authorization_RequestDenied",
        "Insufficient privileges to complete the operation.",
        "/users/delta?$select=id",
      ),
    );
    expect(cause.code).toBe("graph.permission_missing");
    expect(cause.params.permission).toBe("User.Read.All");
  });

  it("MailboxNotEnabledForRESTAPI: the mailbox is not licensed or enabled", () => {
    const cause = classifyFailure(
      graph(
        404,
        "MailboxNotEnabledForRESTAPI",
        "The mailbox is either inactive, soft-deleted, or is hosted on-premise.",
        "/users/a@b.de/mailFolders",
      ),
    );
    expect(cause.code).toBe("graph.mailbox_not_licensed");
    expect(cause.params.reason).toBe("not_enabled");
  });

  it("MailboxNotHostedInExchangeOnline: named as not in Exchange Online", () => {
    const cause = classifyFailure(
      graph(
        404,
        "MailboxNotHostedInExchangeOnline",
        "The mailbox is hosted on-premise.",
        "/users/a@b.de/messages",
      ),
    );
    expect(cause.code).toBe("graph.mailbox_not_licensed");
    expect(cause.params.reason).toBe("not_in_exchange_online");
  });

  it("404 on a user that no longer exists: the user was removed", () => {
    const cause = classifyFailure(
      graph(
        404,
        "Request_ResourceNotFound",
        "Resource 'x' does not exist or one of its queried reference-property objects are not present.",
        "/users/gone@b.de",
      ),
    );
    expect(cause.code).toBe("graph.user_not_found");
  });

  it("ErrorInvalidUser: the mailbox owner is gone", () => {
    expect(
      classifyFailure(
        graph(
          404,
          "ErrorInvalidUser",
          "The requested user is invalid.",
          "/users/x@b.de/mailFolders",
        ),
      ).code,
    ).toBe("graph.user_not_found");
  });

  it("404 on an item that was deleted or moved meanwhile: transient, the next run sees the new state", () => {
    const cause = classifyFailure(
      graph(
        404,
        "ErrorItemNotFound",
        "The specified object was not found in the store.",
        "/users/a@b.de/messages/AAMk",
      ),
    );
    expect(cause).toMatchObject({ code: "graph.item_not_found", transient: true });
    expect(
      classifyFailure(graph(404, "itemNotFound", "Item does not exist", "/drives/b!x/items/01ABC"))
        .code,
    ).toBe("graph.item_not_found");
  });

  it("a tenant without SharePoint or OneDrive licence: OneDrive unavailable", () => {
    expect(
      classifyFailure(
        graph(400, "BadRequest", "Tenant does not have a SPO license.", "/users/a@b.de/drive"),
      ).code,
    ).toBe("graph.onedrive_unavailable");
  });

  it("404 on a drive: OneDrive not provisioned", () => {
    const cause = classifyFailure(
      graph(404, "ResourceNotFound", "Resource could not be discovered.", "/users/a@b.de/drive"),
    );
    expect(cause.code).toBe("graph.onedrive_unavailable");
  });

  it("429 with Retry-After: throttled, transient, with the wait", () => {
    const cause = classifyFailure(
      graph(
        429,
        "TooManyRequests",
        "Application is over its MailboxConcurrency limit.",
        "/users/a@b.de/messages",
        {
          headers: { "retry-after": "32" },
        },
      ),
    );
    expect(cause).toMatchObject({ code: "graph.throttled", transient: true });
    expect(cause.params.retryAfterSeconds).toBe(32);
  });

  it("429 without Retry-After is still throttling", () => {
    const cause = classifyFailure(
      graph(429, "activityLimitReached", "slow down", "/users/a@b.de/events"),
    );
    expect(cause.code).toBe("graph.throttled");
    expect(cause.params.retryAfterSeconds).toBeUndefined();
  });

  it("5xx: Microsoft service trouble, transient", () => {
    for (const [status, code] of [
      [500, "generalException"],
      [502, "badGateway"],
      [503, "ServiceNotAvailable"],
      [504, "gatewayTimeout"],
    ] as const) {
      const cause = classifyFailure(graph(status, code, "try again", "/users/a@b.de/messages"));
      expect(cause, `${status} ${code}`).toMatchObject({
        code: "graph.service_unavailable",
        transient: true,
      });
    }
  });

  it("401: the token was rejected (transient, the next attempt fetches a new one)", () => {
    const cause = classifyFailure(
      graph(
        401,
        "InvalidAuthenticationToken",
        "Access token has expired or is not yet valid.",
        "/users/a@b.de/messages",
      ),
    );
    expect(cause).toMatchObject({ code: "graph.token_rejected", transient: true });
  });

  it("413 and message-size codes: the item is too large", () => {
    expect(
      classifyFailure(graph(413, "requestEntityTooLarge", "big", "/users/a@b.de/messages")).code,
    ).toBe("graph.item_too_large");
    expect(
      classifyFailure(
        graph(
          400,
          "ErrorMessageSizeExceeded",
          "The message exceeds the maximum supported size.",
          "/users/a@b.de/messages",
        ),
      ).code,
    ).toBe("graph.item_too_large");
  });

  it("corrupt items are unreadable, not a service problem", () => {
    expect(
      classifyFailure(
        graph(500, "ErrorCorruptData", "Data is corrupt.", "/users/a@b.de/messages/AAMk/$value"),
      ).code,
    ).toBe("graph.item_unreadable");
  });

  it("410: the delta token expired", () => {
    expect(
      classifyFailure(
        graph(
          410,
          "syncStateNotFound",
          "The sync state was not found.",
          "/users/a@b.de/mailFolders/inbox/messages/delta",
        ),
      ),
    ).toMatchObject({ code: "graph.delta_expired", transient: true });
  });

  it("507 and quota codes: the target is full", () => {
    expect(
      classifyFailure(graph(507, "ErrorQuotaExceeded", "quota", "/users/a@b.de/messages")).code,
    ).toBe("graph.quota_exceeded");
  });

  it("any other refusal is a rejected request with its code kept", () => {
    const cause = classifyFailure(
      graph(400, "ErrorInvalidRequest", "bad", "/users/a@b.de/messages"),
    );
    expect(cause.code).toBe("graph.request_rejected");
    expect(cause.params.graphCode).toBe("ErrorInvalidRequest");
  });

  it("falls back to the response headers for the request id", () => {
    const error = new GraphError({
      status: 500,
      method: "GET",
      url: `${BASE}/users/a@b.de/messages`,
      headers: { "request-id": "hdr-1", "client-request-id": "hdr-2" },
      payload: {},
    });
    expect(classifyFailure(error).technical).toMatchObject({
      requestId: "hdr-1",
      clientRequestId: "hdr-2",
    });
  });

  it("keeps query strings and tokens out of the technical details", () => {
    const error = new GraphError({
      status: 400,
      method: "GET",
      url: `${BASE}/users/a@b.de/messages?$filter=x&access_token=SECRET123456`,
      payload: { error: { code: "Bad", message: "Bearer abcdefghijklmnop was rejected" } },
    });
    const text = JSON.stringify(classifyFailure(error));
    expect(text).not.toContain("SECRET123456");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("$filter");
  });
});

describe("Entra token endpoint refusals", () => {
  function token(status: number, code: string, message: string) {
    return new TokenAcquisitionError(message, { status, code, correlationId: "corr-1" });
  }

  it("AADSTS65001 and 700016: consent is missing or was revoked", () => {
    expect(
      classifyFailure(
        token(
          400,
          "invalid_grant",
          "Token request failed with 400 (invalid_grant): AADSTS65001: The user or administrator has not consented",
        ),
      ).code,
    ).toBe("graph.consent_missing");
    expect(
      classifyFailure(
        token(
          400,
          "unauthorized_client",
          "Token request failed with 400 (unauthorized_client): AADSTS700016: Application with identifier 'x' was not found in the directory",
        ),
      ).code,
    ).toBe("graph.consent_missing");
  });

  it("AADSTS7000215 and 7000222: the app credential is rejected, with the reason", () => {
    const invalid = classifyFailure(
      token(
        401,
        "invalid_client",
        "Token request failed with 401 (invalid_client): AADSTS7000215: Invalid client secret provided.",
      ),
    );
    expect(invalid).toMatchObject({ code: "graph.app_credentials_invalid" });
    expect(invalid.params).toMatchObject({ reason: "invalid_secret", aadsts: "AADSTS7000215" });
    const expired = classifyFailure(
      token(
        401,
        "invalid_client",
        "Token request failed with 401 (invalid_client): AADSTS7000222: The provided client secret keys are expired.",
      ),
    );
    expect(expired.params.reason).toBe("secret_expired");
  });

  it("AADSTS90002: the tenant is unknown", () => {
    expect(
      classifyFailure(
        token(
          400,
          "invalid_request",
          "Token request failed with 400 (invalid_request): AADSTS90002: Tenant 'x' not found.",
        ),
      ).code,
    ).toBe("graph.tenant_not_found");
  });

  it("keeps the correlation id for a support case and never the secret", () => {
    const cause = classifyFailure(
      token(
        401,
        "invalid_client",
        "Token request failed with 401: AADSTS7000215: bad client_secret=hunter2hunter2",
      ),
    );
    expect(cause.technical.correlationId).toBe("corr-1");
    expect(JSON.stringify(cause)).not.toContain("hunter2");
  });
});

describe("IMAP errors", () => {
  it("imapflow authentication failure: auth failed, response text kept", () => {
    const error = withCode(new Error("Command failed"), {
      authenticationFailed: true,
      response: "a2 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)",
      responseStatus: "NO",
      responseText: "Invalid credentials (Failure)",
      serverResponseCode: "AUTHENTICATIONFAILED",
      executedCommand: 'a2 LOGIN "user@example.test" "s3cretPassw0rd"',
    });
    const cause = classifyFailure(error, { role: "imap", host: "imap.example.test" });
    expect(cause.code).toBe("imap.auth_failed");
    expect(cause.technical.imapResponse).toContain("Invalid credentials");
    expect(JSON.stringify(cause)).not.toContain("s3cretPassw0rd");
  });

  it("the connector's ImapAuthError is an authentication failure", () => {
    expect(
      classifyFailure(new ImapAuthError("authentication failed", "NO [AUTHENTICATIONFAILED]")).code,
    ).toBe("imap.auth_failed");
  });

  it("OAuth2 failures: an expired refresh token, a broken client, an unreachable endpoint", () => {
    const grant = classifyFailure(
      new OAuth2Error("token refresh failed (400 invalid_grant): expired", 400, "invalid_grant"),
    );
    expect(grant).toMatchObject({ code: "imap.oauth_failed" });
    expect(grant.params.reason).toBe("token_expired");
    expect(
      classifyFailure(
        new OAuth2Error("token refresh failed (401 invalid_client)", 401, "invalid_client"),
      ).params.reason,
    ).toBe("client_invalid");
    expect(
      classifyFailure(new OAuth2Error("token endpoint unreachable: fetch failed", null, "network")),
    ).toMatchObject({
      code: "network.unreachable",
      transient: true,
    });
  });

  it("an ImapSessionError wrapping a socket error reports the socket problem", () => {
    const socket = withCode(new Error("connect ECONNREFUSED 10.0.0.9:993"), {
      code: "ECONNREFUSED",
      address: "10.0.0.9",
      port: 993,
    });
    const cause = classifyFailure(
      new ImapSessionError("connect ECONNREFUSED 10.0.0.9:993 (ECONNREFUSED)", true, {
        cause: socket,
      }),
      {
        host: "imap.example.test",
      },
    );
    expect(cause.code).toBe("network.unreachable");
    expect(cause.params).toMatchObject({ role: "imap", port: 993 });
  });

  it("a dropped session without a socket error is a lost connection", () => {
    expect(classifyFailure(new ImapSessionError("Connection not available", true))).toMatchObject({
      code: "imap.connection_lost",
      transient: true,
    });
  });

  it("a refused command keeps the server text", () => {
    const cause = classifyFailure(
      new ImapSessionError("Command failed", false, {
        cause: withCode(new Error("Command failed"), {
          responseStatus: "NO",
          responseText: "Mailbox doesn't exist: Archive/2019",
          serverResponseCode: "NONEXISTENT",
          executedCommand: "a5 SELECT Archive/2019",
        }),
      }),
    );
    expect(cause.code).toBe("imap.command_failed");
    expect(cause.technical).toMatchObject({ imapCode: "NONEXISTENT", imapCommand: "SELECT" });
  });

  it("over quota during an append is a full mailbox", () => {
    const cause = classifyFailure(
      withCode(new Error("Command failed"), {
        responseStatus: "NO",
        responseText: "Quota exceeded (mailbox for user is full)",
        serverResponseCode: "OVERQUOTA",
      }),
    );
    expect(cause.code).toBe("imap.mailbox_full");
  });

  it("config errors: blocked address, missing STARTTLS, anything else", () => {
    expect(
      classifyFailure(
        new ImapConfigError("connections to 10.0.0.9 are not allowed: it is not a public address"),
      ).code,
    ).toBe("imap.address_blocked");
    expect(
      classifyFailure(new ImapConfigError("server does not offer STARTTLS; TLS is required")).code,
    ).toBe("imap.starttls_unavailable");
    expect(classifyFailure(new ImapConfigError("IMAP source has no server configured")).code).toBe(
      "imap.config_invalid",
    );
  });
});

describe("network errors", () => {
  it("DNS failures name the host", () => {
    const cause = classifyFailure(
      withCode(new Error("getaddrinfo ENOTFOUND imap.example.test"), {
        code: "ENOTFOUND",
        hostname: "imap.example.test",
      }),
      {
        role: "imap",
      },
    );
    expect(cause).toMatchObject({ code: "network.dns", transient: true });
    expect(cause.params).toMatchObject({ host: "imap.example.test", role: "imap" });
  });

  it("timeouts", () => {
    expect(
      classifyFailure(withCode(new Error("connect ETIMEDOUT 1.2.3.4:993"), { code: "ETIMEDOUT" }))
        .code,
    ).toBe("network.timeout");
    expect(
      classifyFailure(
        Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        }),
      ).code,
    ).toBe("network.timeout");
  });

  it("certificate problems carry the reason", () => {
    const expired = classifyFailure(
      withCode(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
      { role: "imap" },
    );
    expect(expired).toMatchObject({ code: "network.tls" });
    expect(expired.params.reason).toBe("expired");
    expect(
      classifyFailure(
        withCode(new Error("Hostname/IP does not match certificate's altnames"), {
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        }),
      ).params.reason,
    ).toBe("hostname_mismatch");
    expect(
      classifyFailure(
        withCode(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      ).params.reason,
    ).toBe("self_signed");
  });

  it("a fetch failure to Microsoft is attributed to Microsoft through the wrapped socket error", () => {
    const socket = withCode(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      hostname: "graph.microsoft.com",
    });
    const fetchFailed = new TypeError("fetch failed", { cause: socket });
    const cause = classifyFailure(fetchFailed);
    expect(cause.code).toBe("network.unreachable");
    expect(cause.params.role).toBe("microsoft");
  });
});

describe("storage errors", () => {
  it("a full disk", () => {
    const error = withCode(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
      syscall: "write",
      path: "/data/tenants/t/packs/ab/abcdef.restow-tmp",
    });
    expect(classifyFailure(error)).toMatchObject({ code: "storage.full" });
  });

  it("a folder Restow may not write to", () => {
    const error = withCode(new Error("EACCES: permission denied, mkdir '/data/tenants'"), {
      code: "EACCES",
      syscall: "mkdir",
      path: "/data/tenants",
    });
    const cause = classifyFailure(error);
    expect(cause.code).toBe("storage.not_writable");
    expect(cause.params.path).toBe("/data/tenants");
  });

  it("a missing mount", () => {
    const error = withCode(new Error("ENOENT: no such file or directory, open '/mnt/backup/x'"), {
      code: "ENOENT",
      syscall: "open",
      path: "/mnt/backup/x",
    });
    expect(classifyFailure(error).code).toBe("storage.path_missing");
  });

  it("S3 errors by name and by HTTP status", () => {
    const denied = withCode(new Error("Access Denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    expect(classifyFailure(denied).code).toBe("storage.access_denied");
    const key = withCode(new Error("The AWS Access Key Id you provided does not exist"), {
      name: "InvalidAccessKeyId",
      $metadata: { httpStatusCode: 403 },
    });
    expect(classifyFailure(key).code).toBe("storage.credentials_invalid");
    const bucket = withCode(new Error("The specified bucket does not exist"), {
      name: "NoSuchBucket",
      $metadata: { httpStatusCode: 404 },
    });
    expect(classifyFailure(bucket).code).toBe("storage.bucket_missing");
    const slow = withCode(new Error("Please reduce your request rate."), {
      name: "SlowDown",
      $metadata: { httpStatusCode: 503 },
    });
    expect(classifyFailure(slow)).toMatchObject({ code: "storage.rate_limited", transient: true });
    const redirect = withCode(new Error("moved"), {
      name: "PermanentRedirect",
      $metadata: { httpStatusCode: 301 },
    });
    expect(classifyFailure(redirect).code).toBe("storage.wrong_region");
  });

  it("a socket error from the S3 SDK is a storage problem, not a generic network one", () => {
    const error = withCode(new Error("connect ECONNREFUSED 127.0.0.1:9000"), {
      code: "ECONNREFUSED",
      $metadata: { attempts: 3 },
    });
    expect(classifyFailure(error).code).toBe("storage.unreachable");
  });

  it("a chunk store failure is classified by what it wraps", () => {
    const cause = withCode(new Error("ENOSPC: no space left on device"), {
      code: "ENOSPC",
      syscall: "write",
    });
    expect(classifyFailure(new ChunkStoreFailedError(12, cause)).code).toBe("storage.full");
    const denied = withCode(new Error("Access Denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    expect(classifyFailure(new ChunkStoreFailedError(3, denied)).code).toBe(
      "storage.access_denied",
    );
    expect(
      classifyFailure(new ChunkStoreFailedError(3, new Error("index insert failed"))).code,
    ).toBe("storage.error");
  });

  it("a caller-provided storage role turns a bare socket error into a storage problem", () => {
    const error = withCode(new Error("getaddrinfo ENOTFOUND s3.example.test"), {
      code: "ENOTFOUND",
      hostname: "s3.example.test",
    });
    expect(classifyFailure(error, { role: "storage" }).code).toBe("storage.unreachable");
  });
});

describe("database, encryption and integrity", () => {
  it("Postgres shutdown and connection limits are unavailability", () => {
    const shutdown = withCode(new Error("terminating connection due to administrator command"), {
      name: "error",
      severity: "FATAL",
      code: "57P01",
    });
    expect(classifyFailure(shutdown)).toMatchObject({
      code: "database.unavailable",
      transient: true,
    });
    const tooMany = withCode(new Error("sorry, too many clients already"), {
      severity: "FATAL",
      code: "53300",
    });
    expect(classifyFailure(tooMany).params.reason).toBe("too_many_connections");
  });

  it("other Postgres errors are database errors with the SQLSTATE, not the query", () => {
    const unique = withCode(new Error('duplicate key value violates unique constraint "x"'), {
      severity: "ERROR",
      code: "23505",
    });
    const cause = classifyFailure(unique);
    expect(cause.code).toBe("database.error");
    expect(cause.params.sqlState).toBe("23505");
    const failedQuery = new Error(
      "Failed query: select * from secrets where token = $1\nparams: abc123",
    );
    expect(JSON.stringify(classifyFailure(failedQuery))).not.toContain("abc123");
  });

  it("a connection loss reported only by its message", () => {
    expect(classifyFailure(new Error("Connection terminated unexpectedly")).code).toBe(
      "database.unavailable",
    );
  });

  it("missing and wrong keys", () => {
    expect(classifyFailure(new Error("tenant 1234 has no data-encryption key")).code).toBe(
      "crypto.key_missing",
    );
    expect(
      classifyFailure(new Error("env key provider requires a KEK (set RESTOW_MASTER_KEY)")).code,
    ).toBe("crypto.key_missing");
    expect(
      classifyFailure(new Error("Unsupported state or unable to authenticate data")).code,
    ).toBe("crypto.key_invalid");
  });

  it("integrity findings of the read-back path", () => {
    expect(
      classifyFailure(new RestoreIntegrityError("object differs from the manifest")).code,
    ).toBe("verify.hash_mismatch");
    expect(classifyFailure(new MissingChunkError("ab12")).code).toBe("verify.chunk_missing");
  });

  it("an aborted job says why it was interrupted", () => {
    const cause = classifyFailure(new JobAbortedError(), { abortReason: "shutdown" });
    expect(cause).toMatchObject({ code: "job.interrupted", transient: true });
    expect(cause.params.reason).toBe("shutdown");
  });
});

describe("wrapping and fallbacks", () => {
  it("looks through wrappers to the Graph error", () => {
    const inner = graph(403, "ErrorAccessDenied", "Access is denied.", "/users/a@b.de/mailFolders");
    const wrapped = Object.assign(
      new Error("cannot read mail folders: Graph 403 ErrorAccessDenied"),
      {
        name: "MailboxAccessError",
        cause: inner,
      },
    );
    expect(classifyFailure(wrapped).code).toBe("graph.access_denied");
  });

  it("a wrapper's message does not decide before its cause is examined", () => {
    const socket = withCode(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const wrapper = new Error("cannot read the folder: connection closed by the server", {
      cause: socket,
    });
    expect(classifyFailure(wrapper).code).toBe("network.unreachable");
  });

  it("an error that names its cause is taken at its word", () => {
    const error = new FailureError("no password set", {
      code: "imap.credential_missing",
      params: { account: "a@b.de" },
    });
    expect(classifyFailure(error)).toMatchObject({
      code: "imap.credential_missing",
      transient: false,
      params: { account: "a@b.de" },
    });
    const duck = Object.assign(new Error("skipped"), {
      failure: { code: "config.source_disabled", transient: false, params: {}, technical: {} },
    });
    expect(classifyFailure(duck).code).toBe("config.source_disabled");
  });

  it("what nothing recognises becomes unknown, keeping the redacted message", () => {
    const cause = classifyFailure(
      new RangeError("something odd happened with Bearer abcdefghijklmnopqrstuv"),
    );
    expect(cause.code).toBe("unknown");
    expect(cause.technical.errorName).toBe("RangeError");
    expect(String(cause.technical.message)).toContain("something odd happened");
    expect(String(cause.technical.message)).not.toContain("abcdefghijklmnopqrstuv");
  });

  it("copes with non-Error values", () => {
    expect(classifyFailure("boom").technical.message).toBe("boom");
    expect(classifyFailure(undefined).code).toBe("unknown");
    expect(classifyFailure(null).code).toBe("unknown");
    expect(classifyFailure({ some: "object" }).code).toBe("unknown");
  });

  it("survives a cyclic cause chain", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b", { cause: a });
    a.cause = b;
    expect(classifyFailure(a).code).toBe("unknown");
  });
});
