import type { AppCredentials } from "@restow/core";
import { describe, expect, it } from "vitest";
import { GraphNotifier, graphSendFailureReason, graphTokenFailureReason } from "./notify-graph.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const APP: AppCredentials = {
  clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  credential: { type: "secret", clientSecret: "fixture-client-secret-value" },
};
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const SEND_URL = "https://graph.microsoft.com/v1.0/users/alerts%40contoso.com/sendMail";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(answers: { token?: () => Response; send?: () => Response }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === TOKEN_URL) {
      return (
        answers.token?.() ??
        Response.json({ access_token: "eyJ.fixture", expires_in: 3599, token_type: "Bearer" })
      );
    }
    if (url === SEND_URL) {
      return answers.send?.() ?? new Response(null, { status: 202 });
    }
    return new Response("unexpected", { status: 599 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function notifier(fetchImpl: typeof fetch, overrides: Partial<{ tenantId: string | null }> = {}) {
  return new GraphNotifier({
    sender: "alerts@contoso.com",
    tenantId: overrides.tenantId === undefined ? TENANT : overrides.tenantId,
    app: APP,
    fetchImpl,
  });
}

function tokenError(code: string, description: string, status = 401) {
  return () => Response.json({ error: code, error_description: description }, { status });
}

describe("graphTokenFailureReason", () => {
  it("maps the AADSTS codes an admin runs into", () => {
    const cases: [string, string][] = [
      ["AADSTS7000215: Invalid client secret provided.", "graph_secret_invalid"],
      [
        "AADSTS7000222: The provided client secret keys for app are expired.",
        "graph_secret_expired",
      ],
      ["AADSTS700027: Client assertion failed signature validation.", "graph_certificate_invalid"],
      [
        "AADSTS700016: Application with identifier was not found in the directory.",
        "graph_app_not_found",
      ],
      ["AADSTS90002: Tenant 'x' not found.", "graph_tenant_not_found"],
      [
        "AADSTS900023: Specified tenant identifier is neither a valid DNS name, nor a valid external domain.",
        "graph_tenant_not_found",
      ],
      ["AADSTS50000: Something else.", "graph_token_failed"],
      ["fetch failed", "graph_token_failed"],
    ];
    for (const [message, reason] of cases) {
      expect(graphTokenFailureReason(message)).toBe(reason);
    }
  });
});

describe("graphSendFailureReason", () => {
  it("maps Graph's answers to sendMail", () => {
    expect(
      graphSendFailureReason(403, {
        error: {
          code: "ErrorAccessDenied",
          message: "Access is denied. Check credentials and try again.",
        },
      }),
    ).toBe("graph_send_denied");
    expect(
      graphSendFailureReason(404, {
        error: { code: "ErrorInvalidUser", message: "The requested user 'x' is invalid." },
      }),
    ).toBe("graph_sender_not_found");
    expect(graphSendFailureReason(400, { error: { code: "MailboxNotEnabledForRESTAPI" } })).toBe(
      "graph_sender_not_found",
    );
    expect(graphSendFailureReason(401, null)).toBe("graph_token_failed");
    expect(graphSendFailureReason(400, { error: { code: "ErrorInvalidRecipients" } })).toBe(
      "transport_error",
    );
  });
});

describe("GraphNotifier", () => {
  it("gets an app-only token for the tenant and posts sendMail as the sender", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    await expect(notifier(fetchImpl).sendTest("admin@contoso.com", "de")).resolves.toEqual({
      ok: true,
    });
    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, SEND_URL]);
    const tokenBody = new URLSearchParams(String(calls[0]?.init.body));
    expect(tokenBody.get("grant_type")).toBe("client_credentials");
    expect(tokenBody.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(tokenBody.get("client_id")).toBe(APP.clientId);
    const send = calls[1];
    expect((send?.init.headers as Record<string, string>).Authorization).toBe("Bearer eyJ.fixture");
    const body = JSON.parse(String(send?.init.body));
    expect(body.saveToSentItems).toBe(false);
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: "admin@contoso.com" } }]);
    expect(body.message.subject).toContain("Testbenachrichtigung");
  });

  it("explains a wrong client secret (often the Secret ID instead of its value)", async () => {
    const { fetchImpl, calls } = fakeFetch({
      token: tokenError("invalid_client", "AADSTS7000215: Invalid client secret provided."),
    });
    const result = await notifier(fetchImpl).sendTest("admin@contoso.com", "en");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("graph_secret_invalid");
    expect(result.error).toContain("AADSTS7000215");
    expect(result.error).not.toContain("fixture-client-secret-value");
    expect(calls).toHaveLength(1);
  });

  it("explains a missing Mail.Send permission or an access policy", async () => {
    const { fetchImpl } = fakeFetch({
      send: () =>
        Response.json(
          { error: { code: "ErrorAccessDenied", message: "Access is denied." } },
          { status: 403 },
        ),
    });
    await expect(notifier(fetchImpl).sendTest("admin@contoso.com", "en")).resolves.toEqual({
      ok: false,
      reason: "graph_send_denied",
      error: "Graph sendMail returned 403 (ErrorAccessDenied): Access is denied.",
    });
  });

  it("explains an unknown sender mailbox", async () => {
    const { fetchImpl } = fakeFetch({
      send: () =>
        Response.json(
          { error: { code: "ErrorInvalidUser", message: "The requested user is invalid." } },
          { status: 404 },
        ),
    });
    const result = await notifier(fetchImpl).sendTest("admin@contoso.com", "en");
    expect(result.reason).toBe("graph_sender_not_found");
  });

  it("refuses without a tenant or an app and sends nothing", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const noTenant = await notifier(fetchImpl, { tenantId: null }).sendTest("a@contoso.com", "en");
    expect(noTenant.reason).toBe("graph_tenant_missing");
    const noApp = await new GraphNotifier({
      sender: "alerts@contoso.com",
      tenantId: TENANT,
      app: null,
      fetchImpl,
    }).sendTest("a@contoso.com", "en");
    expect(noApp.reason).toBe("graph_app_missing");
    expect(calls).toHaveLength(0);
  });
});
