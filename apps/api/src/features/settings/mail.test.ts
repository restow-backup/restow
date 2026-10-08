import type { AppCredentials } from "@restow/core";
import type { SupportedLanguage } from "@restow/i18n";
import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../../config.js";
import type { GoogleServiceAccountKey } from "../../notify-google.js";
import type { Notifier, NotifyResult, TransportSpec } from "../../notify.js";
import { type ResolvedMailTransport, runMailTest, sanitizeDetail, transportSpec } from "./mail.js";

const base: Config = loadConfig({ GRAPH_MAIL_TENANT_ID: "env-tenant.onmicrosoft.com" });

/** The resolved app registration Graph sendMail authenticates as. */
const graphApp: AppCredentials = {
  clientId: "fixture-client-id",
  credential: { type: "secret", clientSecret: "fixture-client-secret" },
};

const googleKey: GoogleServiceAccountKey = {
  clientEmail: "notify@project.iam.gserviceaccount.com",
  clientId: "112233445566778899",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\nfixture-private-key\n-----END PRIVATE KEY-----",
  privateKeyId: "kid",
  projectId: "project",
};

const smtp: ResolvedMailTransport = {
  transport: "smtp",
  host: "smtp.example.com",
  port: 465,
  security: "implicit",
  from: "restow@example.com",
  username: "restow",
  password: "fixture-password",
};

const graph: ResolvedMailTransport = {
  transport: "graph",
  sender: "restow@contoso.com",
  tenantId: null,
  app: "backup",
  credentials: graphApp,
};

const ownGraph: ResolvedMailTransport = {
  transport: "graph",
  sender: "restow@contoso.com",
  tenantId: "11111111-2222-3333-4444-555555555555",
  app: "own",
  credentials: graphApp,
};

const google: ResolvedMailTransport = {
  transport: "google",
  sender: "alerts@example.com",
  key: googleKey,
};

/** A notifier fixture that records what it was built from and answers as told. */
function fixtureNotifier(answer: () => Promise<NotifyResult>) {
  const seen: {
    spec: TransportSpec | null;
    to: string | null;
    language: SupportedLanguage | null;
  } = { spec: null, to: null, language: null };
  const notifierFor = (spec: TransportSpec): Notifier => {
    seen.spec = spec;
    return {
      send: answer,
      sendTest: (to, language) => {
        seen.to = to;
        seen.language = language;
        return answer();
      },
    };
  };
  return { seen, notifierFor };
}

function steppingClock(step: number) {
  let now = 1_000;
  return () => {
    now += step;
    return now;
  };
}

describe("transportSpec", () => {
  it("only authenticates SMTP when a username is configured", () => {
    const spec = transportSpec(base, { ...smtp, username: null, password: "leftover" });
    expect(spec).toMatchObject({ smtp: { username: undefined, password: undefined } });
  });

  it("maps SMTP settings onto the notifier", () => {
    expect(transportSpec(base, smtp)).toEqual({
      transport: "smtp",
      smtp: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        security: "implicit",
        username: "restow",
        password: "fixture-password",
        from: "restow@example.com",
      },
    });
  });

  it("uses the stored Graph tenant, else the environment's for the backup app only", () => {
    expect(transportSpec(base, graph)).toMatchObject({ tenantId: "env-tenant.onmicrosoft.com" });
    expect(transportSpec(base, { ...graph, tenantId: "contoso.onmicrosoft.com" })).toMatchObject({
      tenantId: "contoso.onmicrosoft.com",
      sender: "restow@contoso.com",
      app: graphApp,
    });
    expect(transportSpec(base, { ...ownGraph, tenantId: null })).toMatchObject({ tenantId: null });
  });

  it("hands the Google key to the notifier", () => {
    expect(transportSpec(base, google)).toEqual({
      transport: "google",
      sender: "alerts@example.com",
      key: googleKey,
    });
  });
});

describe("runMailTest", () => {
  it("reports a successful send with recipient and duration, in the requester's language", async () => {
    const { seen, notifierFor } = fixtureNotifier(async () => ({ ok: true }));
    const result = await runMailTest(smtp, "ops@example.com", "de", {
      base,
      notifierFor,
      clock: steppingClock(40),
    });
    expect(result).toEqual({
      ok: true,
      transport: "smtp",
      recipient: "ops@example.com",
      durationMs: 40,
      failure: null,
    });
    expect(seen.to).toBe("ops@example.com");
    expect(seen.language).toBe("de");
    expect(seen.spec).toMatchObject({ smtp: { host: "smtp.example.com" } });
  });

  it("passes the transport's reason on, with the password redacted", async () => {
    const { notifierFor } = fixtureNotifier(async () => ({
      ok: false,
      reason: "smtp_auth_failed",
      error: "535 Authentication failed for fixture-password",
    }));
    const result = await runMailTest(smtp, "ops@example.com", "de", { base, notifierFor });
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({
      reason: "smtp_auth_failed",
      detail: "535 Authentication failed for [redacted]",
    });
  });

  it("falls back to a transport error when the transport names no reason", async () => {
    const { notifierFor } = fixtureNotifier(async () => ({ ok: false, error: "boom" }));
    const result = await runMailTest(smtp, "ops@example.com", "de", { base, notifierFor });
    expect(result.failure).toEqual({ reason: "transport_error", detail: "boom" });
  });

  it("redacts the app secret and the Google key from a detail", async () => {
    const graphRun = fixtureNotifier(async () => ({
      ok: false,
      reason: "graph_token_failed",
      error: "echo fixture-client-secret",
    }));
    const graphResult = await runMailTest(ownGraph, "ops@example.com", "en", {
      base,
      notifierFor: graphRun.notifierFor,
    });
    expect(graphResult.failure?.detail).toBe("echo [redacted]");

    const googleRun = fixtureNotifier(async () => ({
      ok: false,
      reason: "google_token_failed",
      error: `echo ${googleKey.privateKeyPem}`,
    }));
    const googleResult = await runMailTest(google, "ops@example.com", "en", {
      base,
      notifierFor: googleRun.notifierFor,
    });
    expect(googleResult.failure?.detail).toBe("echo [redacted]");
  });

  it("turns a thrown error into a transport error instead of throwing", async () => {
    const result = await runMailTest(smtp, "ops@example.com", "de", {
      base,
      notifierFor: () => {
        throw new Error("connect ECONNREFUSED 10.0.0.25:465");
      },
    });
    expect(result.failure).toEqual({
      reason: "transport_error",
      detail: "connect ECONNREFUSED 10.0.0.25:465",
    });
  });

  it("gives up after the timeout", async () => {
    const { notifierFor } = fixtureNotifier(() => new Promise<NotifyResult>(() => undefined));
    const result = await runMailTest(smtp, "ops@example.com", "de", {
      base,
      notifierFor,
      timeoutMs: 5,
    });
    expect(result.failure).toEqual({ reason: "timeout", detail: null });
  });

  it("does not attempt Graph without the backup app registration", async () => {
    const { seen, notifierFor } = fixtureNotifier(async () => ({ ok: true }));
    const result = await runMailTest({ ...graph, credentials: null }, "ops@example.com", "de", {
      base,
      notifierFor,
    });
    expect(result.failure).toEqual({ reason: "graph_app_missing", detail: null });
    expect(seen.spec).toBeNull();
  });

  it("does not attempt Graph without the own app's stored credential", async () => {
    const { seen, notifierFor } = fixtureNotifier(async () => ({ ok: true }));
    const result = await runMailTest({ ...ownGraph, credentials: null }, "ops@example.com", "de", {
      base,
      notifierFor,
    });
    expect(result.failure).toEqual({ reason: "graph_credential_missing", detail: null });
    expect(seen.spec).toBeNull();
  });

  it("does not attempt Graph without a tenant", async () => {
    const { notifierFor } = fixtureNotifier(async () => ({ ok: true }));
    const result = await runMailTest(graph, "ops@example.com", "de", {
      base: loadConfig({}),
      notifierFor,
    });
    expect(result.failure).toEqual({ reason: "graph_tenant_missing", detail: null });
    // The own app never borrows GRAPH_MAIL_TENANT_ID.
    const own = await runMailTest({ ...ownGraph, tenantId: null }, "ops@example.com", "de", {
      base,
      notifierFor,
    });
    expect(own.failure).toEqual({ reason: "graph_tenant_missing", detail: null });
  });

  it("does not attempt Google without a key", async () => {
    const { seen, notifierFor } = fixtureNotifier(async () => ({ ok: true }));
    const result = await runMailTest({ ...google, key: null }, "ops@example.com", "de", {
      base,
      notifierFor,
    });
    expect(result.failure).toEqual({ reason: "google_key_missing", detail: null });
    expect(seen.spec).toBeNull();
  });

  it("sends through Graph as the resolved app registration", async () => {
    const { seen, notifierFor } = fixtureNotifier(async () => ({ ok: true }));
    const result = await runMailTest(ownGraph, "ops@example.com", "en", { base, notifierFor });
    expect(result).toMatchObject({ ok: true, transport: "graph" });
    expect(seen.spec).toEqual({
      transport: "graph",
      sender: "restow@contoso.com",
      tenantId: "11111111-2222-3333-4444-555555555555",
      app: graphApp,
    });
  });

  it("sends nothing in demo mode", async () => {
    const demo = loadConfig({ RESTOW_DEMO: "true" });
    const result = await runMailTest(google, "ops@example.com", "en", { base: demo });
    expect(result.ok).toBe(true);
  });
});

describe("sanitizeDetail", () => {
  it("drops empty messages and bounds long ones", () => {
    expect(sanitizeDetail("   ", null)).toBeNull();
    expect(sanitizeDetail(undefined, "x")).toBeNull();
    const long = sanitizeDetail("x".repeat(600), null) ?? "";
    expect(long.length).toBe(501);
    expect(long.endsWith("…")).toBe(true);
  });

  it("redacts every secret it is given", () => {
    expect(sanitizeDetail("a=secret-one b=secret-two", ["secret-one", "secret-two"])).toBe(
      "a=[redacted] b=[redacted]",
    );
  });
});
