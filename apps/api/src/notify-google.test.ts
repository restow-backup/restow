import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GMAIL_SEND_SCOPE,
  GMAIL_SEND_URL,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleNotifier,
  type GoogleServiceAccountKey,
  buildMimeMessage,
  buildServiceAccountAssertion,
  gmailSendFailureReason,
  googleTokenFailureReason,
  parseServiceAccountKey,
  serializeServiceAccountKey,
} from "./notify-google.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/** A key file as Google hands it out (IAM › Service accounts › Keys › JSON). */
const KEY_FILE = {
  type: "service_account",
  project_id: "restow-notify",
  private_key_id: "abc123keyid",
  private_key: PRIVATE_KEY_PEM,
  client_email: "notify@restow-notify.iam.gserviceaccount.com",
  client_id: "112233445566778899001",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://attacker.example/token",
  universe_domain: "googleapis.com",
};

function parsedKey(): GoogleServiceAccountKey {
  const parsed = parseServiceAccountKey(JSON.stringify(KEY_FILE));
  if (!parsed.ok) {
    throw new Error(`fixture key did not parse: ${parsed.problem}`);
  }
  return parsed.key;
}

function decodeSegment(segment: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment ?? "", "base64url").toString("utf8"));
}

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch fake answering the token endpoint and the Gmail API from a script. */
function fakeFetch(answers: {
  token?: () => Response;
  send?: () => Response;
}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      return (
        answers.token?.() ??
        Response.json({ access_token: "ya29.fixture", expires_in: 3600, token_type: "Bearer" })
      );
    }
    if (url === GMAIL_SEND_URL) {
      return answers.send?.() ?? Response.json({ id: "18c0ffee", labelIds: ["SENT"] });
    }
    return new Response("unexpected", { status: 599 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("parseServiceAccountKey", () => {
  it("reads a Google key file and keeps only what sending needs", () => {
    const key = parsedKey();
    expect(key).toEqual({
      clientEmail: KEY_FILE.client_email,
      clientId: KEY_FILE.client_id,
      privateKeyPem: PRIVATE_KEY_PEM.trim(),
      privateKeyId: KEY_FILE.private_key_id,
      projectId: KEY_FILE.project_id,
    });
    const sealed = serializeServiceAccountKey(key);
    expect(sealed).not.toContain("attacker.example");
    expect(parseServiceAccountKey(sealed)).toEqual({ ok: true, key });
  });

  it("names the problem of an unusable key without echoing a value", () => {
    expect(parseServiceAccountKey("not json")).toEqual({ ok: false, problem: "json" });
    expect(parseServiceAccountKey("[]")).toEqual({ ok: false, problem: "json" });
    expect(
      parseServiceAccountKey(JSON.stringify({ ...KEY_FILE, type: "authorized_user" })),
    ).toEqual({ ok: false, problem: "type" });
    expect(parseServiceAccountKey(JSON.stringify({ ...KEY_FILE, client_email: "nope" }))).toEqual({
      ok: false,
      problem: "client_email",
    });
    expect(parseServiceAccountKey(JSON.stringify({ ...KEY_FILE, client_id: "x" }))).toEqual({
      ok: false,
      problem: "client_id",
    });
    expect(
      parseServiceAccountKey(JSON.stringify({ ...KEY_FILE, private_key: "-----BEGIN nonsense" })),
    ).toEqual({ ok: false, problem: "private_key" });
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(parseServiceAccountKey(JSON.stringify({ ...KEY_FILE, private_key: ec }))).toEqual({
      ok: false,
      problem: "private_key",
    });
  });
});

describe("buildServiceAccountAssertion", () => {
  it("signs an RS256 JWT for the sender with only the gmail.send scope", () => {
    const nowMs = Date.UTC(2026, 9, 7, 12, 0, 0);
    const jwt = buildServiceAccountAssertion({
      key: parsedKey(),
      subject: "alerts@example.com",
      scope: GMAIL_SEND_SCOPE,
      nowMs,
    });
    const [header, claims, signature] = jwt.split(".");
    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT", kid: "abc123keyid" });
    expect(decodeSegment(claims)).toEqual({
      iss: KEY_FILE.client_email,
      sub: "alerts@example.com",
      scope: "https://www.googleapis.com/auth/gmail.send",
      aud: GOOGLE_TOKEN_ENDPOINT,
      iat: nowMs / 1000,
      exp: nowMs / 1000 + 3600,
    });
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature ?? "", "base64url"));
    expect(verified).toBe(true);
  });
});

describe("buildMimeMessage", () => {
  it("builds an RFC 5322 message with encoded non-ASCII headers", async () => {
    const raw = (
      await buildMimeMessage({
        from: "alerts@example.com",
        message: {
          to: "admin@example.com",
          subject: "Prüfung: Testbenachrichtigung",
          text: "Grüße aus dem Mailversand",
        },
      })
    ).toString("utf8");
    expect(raw).toMatch(/^From: alerts@example\.com\r?$/m);
    expect(raw).toMatch(/^To: admin@example\.com\r?$/m);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(raw).toMatch(/^MIME-Version: 1\.0\r?$/m);
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(raw).toMatch(/^Message-ID: </m);
  });

  it("keeps a header injection attempt on one line", async () => {
    const raw = (
      await buildMimeMessage({
        from: "alerts@example.com",
        message: { to: "admin@example.com", subject: "Hi\r\nBcc: victim@example.com", text: "x" },
      })
    ).toString("utf8");
    expect(raw).not.toMatch(/^Bcc:/m);
  });

  it("sends HTML as an alternative to the text", async () => {
    const raw = (
      await buildMimeMessage({
        from: "alerts@example.com",
        message: { to: "a@example.com", subject: "s", text: "plain", html: "<p>rich</p>" },
      })
    ).toString("utf8");
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("text/html");
  });
});

describe("error mapping", () => {
  it("explains the token endpoint's answers", () => {
    expect(
      googleTokenFailureReason(
        "unauthorized_client",
        "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.",
      ),
    ).toBe("google_delegation_missing");
    expect(googleTokenFailureReason("invalid_grant", "Invalid email or User ID")).toBe(
      "google_sender_not_found",
    );
    expect(googleTokenFailureReason("invalid_grant", "Invalid JWT Signature.")).toBe(
      "google_key_invalid",
    );
    expect(googleTokenFailureReason("invalid_client", "The OAuth client was not found.")).toBe(
      "google_key_invalid",
    );
    expect(
      googleTokenFailureReason("invalid_grant", "Invalid JWT: Token must be short-lived"),
    ).toBe("google_token_failed");
    expect(googleTokenFailureReason(null, null)).toBe("google_token_failed");
  });

  it("explains the Gmail API's answers", () => {
    expect(
      gmailSendFailureReason(403, {
        error: {
          code: 403,
          message: "Gmail API has not been used in project 1 before or it is disabled.",
          status: "PERMISSION_DENIED",
          details: [{ reason: "SERVICE_DISABLED" }],
        },
      }),
    ).toBe("google_api_disabled");
    expect(
      gmailSendFailureReason(403, { error: { errors: [{ reason: "accessNotConfigured" }] } }),
    ).toBe("google_api_disabled");
    expect(gmailSendFailureReason(403, { error: { status: "PERMISSION_DENIED" } })).toBe(
      "google_send_denied",
    );
    expect(
      gmailSendFailureReason(400, {
        error: { message: "Mail service not enabled", errors: [{ reason: "failedPrecondition" }] },
      }),
    ).toBe("google_sender_not_found");
    expect(gmailSendFailureReason(401, null)).toBe("google_token_failed");
    expect(gmailSendFailureReason(500, null)).toBe("transport_error");
  });
});

describe("GoogleNotifier", () => {
  it("gets a delegated token and sends the base64url message through the Gmail API", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const notifier = new GoogleNotifier({
      sender: "alerts@example.com",
      key: parsedKey(),
      fetchImpl,
    });
    await expect(notifier.sendTest("admin@example.com", "de")).resolves.toEqual({ ok: true });
    expect(calls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_ENDPOINT, GMAIL_SEND_URL]);

    const tokenBody = new URLSearchParams(String(calls[0]?.init.body));
    expect(tokenBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(decodeSegment(tokenBody.get("assertion")?.split(".")[1]).sub).toBe("alerts@example.com");
    expect(calls[0]?.init.redirect).toBe("error");

    const send = calls[1];
    expect((send?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer ya29.fixture",
    );
    const raw = JSON.parse(String(send?.init.body)).raw as string;
    expect(raw).not.toMatch(/[+/=]/);
    const message = Buffer.from(raw, "base64url").toString("utf8");
    expect(message).toMatch(/^To: admin@example\.com\r?$/m);
    expect(message).toMatch(/^From: alerts@example\.com\r?$/m);
  });

  it("reuses the token for the next message", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const notifier = new GoogleNotifier({
      sender: "alerts@example.com",
      key: parsedKey(),
      fetchImpl,
    });
    await notifier.send({ to: "a@example.com", subject: "1", text: "1" });
    await notifier.send({ to: "a@example.com", subject: "2", text: "2" });
    expect(calls.filter((call) => call.url === GOOGLE_TOKEN_ENDPOINT)).toHaveLength(1);
  });

  it("maps a missing delegation to a reason and never repeats the key", async () => {
    const { fetchImpl, calls } = fakeFetch({
      token: () =>
        Response.json(
          {
            error: "unauthorized_client",
            error_description: "Client is unauthorized to retrieve access tokens using this method",
          },
          { status: 401 },
        ),
    });
    const result = await new GoogleNotifier({
      sender: "alerts@example.com",
      key: parsedKey(),
      fetchImpl,
    }).sendTest("admin@example.com", "en");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("google_delegation_missing");
    expect(result.error).toContain("unauthorized_client");
    expect(result.error).not.toContain("PRIVATE KEY");
    expect(calls).toHaveLength(1);
  });

  it("maps the Gmail API's refusal", async () => {
    const { fetchImpl } = fakeFetch({
      send: () =>
        Response.json(
          {
            error: {
              code: 403,
              message: "Gmail API disabled",
              details: [{ reason: "SERVICE_DISABLED" }],
            },
          },
          { status: 403 },
        ),
    });
    const result = await new GoogleNotifier({
      sender: "alerts@example.com",
      key: parsedKey(),
      fetchImpl,
    }).sendTest("admin@example.com", "en");
    expect(result).toEqual({
      ok: false,
      reason: "google_api_disabled",
      error: "Gmail API returned 403: Gmail API disabled",
    });
  });

  it("refuses without a key and sends nothing", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const result = await new GoogleNotifier({
      sender: "alerts@example.com",
      key: null,
      fetchImpl,
    }).sendTest("admin@example.com", "en");
    expect(result.reason).toBe("google_key_missing");
    expect(calls).toHaveLength(0);
  });

  it("reports a network failure of the token request", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const result = await new GoogleNotifier({
      sender: "alerts@example.com",
      key: parsedKey(),
      fetchImpl,
    }).sendTest("admin@example.com", "en");
    expect(result).toEqual({ ok: false, reason: "google_token_failed", error: "fetch failed" });
  });
});
