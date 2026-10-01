import type { AppCredentials } from "@restow/core";
import type { SupportedLanguage } from "@restow/i18n";
import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../../config.js";
import type { Notifier, NotifyResult } from "../../notify.js";
import {
  type ResolvedMailTransport,
  notifierConfig,
  resolveMail,
  runMailTest,
  sanitizeDetail,
} from "./mail.js";

const base: Config = loadConfig({ GRAPH_MAIL_TENANT_ID: "env-tenant.onmicrosoft.com" });

/** The resolved backup app registration Graph sendMail authenticates as. */
const graphApp: AppCredentials = {
  clientId: "fixture-client-id",
  credential: { type: "secret", clientSecret: "fixture-client-secret" },
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
};

/** A notifier fixture that records its configuration and answers as told. */
function fixtureNotifier(answer: () => Promise<NotifyResult>) {
  const seen: {
    config: Config | null;
    app: AppCredentials | null;
    to: string | null;
    language: SupportedLanguage | null;
  } = { config: null, app: null, to: null, language: null };
  const notifierFor = (config: Config, app: AppCredentials | null): Notifier => {
    seen.config = config;
    seen.app = app;
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

describe("resolveMail / notifierConfig", () => {
  it("only authenticates when a username is configured", () => {
    expect(
      resolveMail(
        {
          transport: "smtp",
          host: "relay.internal",
          port: 25,
          security: "none",
          from: "restow@example.com",
        },
        "leftover",
      ),
    ).toMatchObject({ username: null, password: null });
  });

  it("maps SMTP settings onto the notifier configuration", () => {
    const config = notifierConfig(base, smtp);
    expect(config.mailTransport).toBe("smtp");
    expect(config.smtp).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      security: "implicit",
      username: "restow",
      password: "fixture-password",
      from: "restow@example.com",
    });
  });

  it("uses the stored Graph tenant, else the environment's", () => {
    expect(notifierConfig(base, graph).graphMailTenantId).toBe("env-tenant.onmicrosoft.com");
    expect(
      notifierConfig(base, { ...graph, tenantId: "contoso.onmicrosoft.com" }).graphMailTenantId,
    ).toBe("contoso.onmicrosoft.com");
    expect(notifierConfig(base, graph).graphMailSender).toBe("restow@contoso.com");
  });
});

describe("runMailTest", () => {
  it("reports a successful send with recipient and duration, in the requester's language", async () => {
    const { seen, notifierFor } = fixtureNotifier(async () => ({ ok: true }));
    const result = await runMailTest(smtp, "ops@example.com", "de", {
      base,
      graphApp,
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
    expect(seen.config?.smtp.host).toBe("smtp.example.com");
  });

  it("passes the transport error on, with the password redacted", async () => {
    const { notifierFor } = fixtureNotifier(async () => ({
      ok: false,
      error: "535 Authentication failed for fixture-password",
    }));
    const result = await runMailTest(smtp, "ops@example.com", "de", {
      base,
      graphApp: null,
      notifierFor,
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({
      reason: "transport_error",
      detail: "535 Authentication failed for [redacted]",
    });
  });

  it("turns a thrown error into a transport error instead of throwing", async () => {
    const result = await runMailTest(smtp, "ops@example.com", "de", {
      base,
      graphApp: null,
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
      graphApp: null,
      notifierFor,
      timeoutMs: 5,
    });
    expect(result.failure).toEqual({ reason: "timeout", detail: null });
  });

  it("does not attempt Graph without the app registration", async () => {
    const { seen, notifierFor } = fixtureNotifier(async () => ({ ok: true }));
    const result = await runMailTest(graph, "ops@example.com", "de", {
      base,
      graphApp: null,
      notifierFor,
    });
    expect(result.failure).toEqual({ reason: "graph_app_missing", detail: null });
    expect(seen.config).toBeNull();
  });

  it("does not attempt Graph without a tenant", async () => {
    const { notifierFor } = fixtureNotifier(async () => ({ ok: true }));
    const result = await runMailTest(graph, "ops@example.com", "de", {
      base: loadConfig({}),
      graphApp,
      notifierFor,
    });
    expect(result.failure).toEqual({ reason: "graph_tenant_missing", detail: null });
  });

  it("sends through Graph as the resolved app registration, SMTP without it", async () => {
    const { seen, notifierFor } = fixtureNotifier(async () => ({ ok: true }));
    const result = await runMailTest(graph, "ops@example.com", "en", {
      base,
      graphApp,
      notifierFor,
    });
    expect(result.ok).toBe(true);
    expect(seen.app).toEqual(graphApp);

    const smtpRun = fixtureNotifier(async () => ({ ok: true }));
    await runMailTest(smtp, "ops@example.com", "en", {
      base,
      graphApp,
      notifierFor: smtpRun.notifierFor,
    });
    expect(smtpRun.seen.app).toBeNull();
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
});
