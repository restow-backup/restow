import { afterEach, describe, expect, it, vi } from "vitest";
import { browserOrigin, clientIp, clientIpOf } from "./request.js";

function header(values: Record<string, string>) {
  return (name: string) => values[name.toLowerCase()];
}

describe("clientIpOf (demo mode off, the default)", () => {
  it("reads the hop the edge appended, never the one the client wrote", () => {
    // Without RESTOW_EDGE_TRUSTED_PROXIES only loopback is trusted, as at the edge.
    expect(clientIpOf(header({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }))).toBe("10.0.0.1");
    expect(clientIpOf(header({ "x-forwarded-for": "203.0.113.5" }))).toBe("203.0.113.5");
  });

  it("skips loopback hops, which the edge trusts by default", () => {
    expect(clientIpOf(header({ "x-forwarded-for": "203.0.113.5, 127.0.0.1" }))).toBe("203.0.113.5");
  });

  it("falls back to X-Real-IP only without any X-Forwarded-For", () => {
    expect(clientIpOf(header({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(
      clientIpOf(header({ "x-forwarded-for": "unknown", "x-real-ip": "203.0.113.9" })),
    ).toBeNull();
  });

  it("is null when neither header is present", () => {
    expect(clientIpOf(header({}))).toBeNull();
  });
});

describe("browserOrigin", () => {
  it("is unaffected by demo mode either way (not client-IP related)", () => {
    expect(
      browserOrigin(
        header({ origin: "https://restow.example.test" }),
        "https://restow.example.test/x",
      ),
    ).toBe("https://restow.example.test");
  });
});

/**
 * `config` (./config.ts) is a module-level singleton read from `process.env`
 * at import time; demo mode is exercised the same way other environment-
 * derived configuration is (see auth.test.ts, middleware/demo-guard.test.ts).
 */
async function loadRequestModule(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return import("./request.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("clientIpOf, demo mode on (security review finding 2)", () => {
  it("is always null, whatever the headers say", async () => {
    const { clientIpOf: demoClientIpOf } = await loadRequestModule({ RESTOW_DEMO: "true" });
    expect(demoClientIpOf(header({ "x-forwarded-for": "203.0.113.5" }))).toBeNull();
    expect(demoClientIpOf(header({ "x-real-ip": "203.0.113.9" }))).toBeNull();
  });

  it("leaves demo mode off (and IPs recorded) when RESTOW_DEMO is unset", async () => {
    const { clientIpOf: offClientIpOf } = await loadRequestModule({});
    expect(offClientIpOf(header({ "x-forwarded-for": "203.0.113.5" }))).toBe("203.0.113.5");
  });
});

describe("clientIpOf behind a trusted front proxy (RESTOW_EDGE_TRUSTED_PROXIES)", () => {
  it("skips the trusted proxy and ignores what the client wrote to its left", async () => {
    const { clientIpOf: behindProxy } = await loadRequestModule({
      RESTOW_EDGE_TRUSTED_PROXIES: "private_ranges",
    });
    // The client sent "X-Forwarded-For: 192.0.2.1"; the front proxy appended the
    // client's real address, the edge appended the front proxy.
    expect(behindProxy(header({ "x-forwarded-for": "192.0.2.1, 203.0.113.50, 172.18.0.1" }))).toBe(
      "203.0.113.50",
    );
  });

  it("does not trust loopback any more once the variable names other ranges", async () => {
    const { clientIpOf: behindProxy } = await loadRequestModule({
      RESTOW_EDGE_TRUSTED_PROXIES: "198.51.100.7",
    });
    expect(behindProxy(header({ "x-forwarded-for": "192.0.2.1, 127.0.0.1" }))).toBe("127.0.0.1");
    expect(
      behindProxy(header({ "x-forwarded-for": "192.0.2.1, 203.0.113.50, 198.51.100.7" })),
    ).toBe("203.0.113.50");
  });
});

describe("clientIp (Hono context wrapper)", () => {
  it("delegates to clientIpOf with the context's own headers", () => {
    const context = {
      req: { header: (name: string) => (name === "x-forwarded-for" ? "203.0.113.1" : undefined) },
    } as Parameters<typeof clientIp>[0];
    expect(clientIp(context)).toBe("203.0.113.1");
  });
});
