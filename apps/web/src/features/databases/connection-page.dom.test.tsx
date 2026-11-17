// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "./i18n.js";
import { ConnectionPage } from "./connection-page.js";
import {
  connectionFixture,
  databaseFixture,
  type Rendered,
  render,
  sessionWithRole,
  slot,
  text,
} from "./testing.js";

/**
 * One connection (docs/DATABASES.md 2.3, 3.2): the stored credentials are only ever "set", a
 * changed certificate is red until an administrator confirms it, and a restore operator reads
 * without the actions.
 */

enableActEnvironment();

let rendered: Rendered | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await rendered?.mounted.unmount();
  rendered = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const OTHER = Array.from({ length: 32 }, () => "AB").join(":");

function detail(over = {}) {
  return {
    ...connectionFixture({
      state: "red",
      notices: ["db_tls_changed"],
      lastCheck: {
        at: "2026-11-17T11:00:00.000Z",
        probeId: "probe-2",
        login: "ok",
        errorCode: "db_tls_changed",
        errorMessage: "The server shows another TLS certificate than the one confirmed.",
        rights: null,
        tlsFingerprintSeen: OTHER,
      },
      ...over,
    }),
    databases: [
      databaseFixture(),
      databaseFixture({
        id: "db-2",
        name: "erp",
        droppedAt: "2026-11-16T10:00:00Z",
        excluded: true,
      }),
    ],
  };
}

describe("a database connection", () => {
  it("shows the credentials as stored, never their value, and asks to confirm a new certificate", async () => {
    let patched: Record<string, unknown> | null = null;
    rendered = await render(<ConnectionPage connectionId="conn-1" />, {
      routes: {
        "GET /databases/connections/conn-1": () => json(detail()),
        "PATCH /databases/connections/conn-1": (request) => {
          patched = request.body as Record<string, unknown>;
          return json(detail({ state: "ok", notices: [], lastCheck: null }));
        },
      },
    });
    expect(slot("connection-credential")?.textContent).toBe(
      "User and password are stored encrypted",
    );
    expect(slot("confirm-change")?.textContent).toContain(OTHER);
    expect(text()).toContain("Gone since");
    await click(buttonByText(document, "Confirm new certificate") as HTMLElement);
    await flush(3);
    const confirm = [...document.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "Confirm new certificate",
    );
    await click(confirm[confirm.length - 1] as HTMLElement);
    await flush(5);
    expect(patched).toEqual({ confirm: { probeId: "probe-2", tls: true, instance: false } });
  });

  it("lets a restore operator read without testing, changing or deleting", async () => {
    rendered = await render(<ConnectionPage connectionId="conn-1" />, {
      routes: { "GET /databases/connections/conn-1": () => json(detail()) },
      session: sessionWithRole("tenant_restore"),
    });
    expect(slot("database-connection-page")).not.toBeNull();
    expect(slot("confirm-change")).toBeNull();
    expect(slot("connection-settings")).toBeNull();
    expect(buttonByText(document, "Delete connection")).toBeNull();
  });

  it("shows the health checks: now, the last 24 hours, availability and events (8)", async () => {
    const band = Array.from({ length: 24 }, (_, index) => ({
      at: new Date(Date.UTC(2026, 10, 16, 12 + index)).toISOString(),
      state: index === 20 ? "down" : index < 2 ? "none" : "ok",
      checks: index < 2 ? 0 : 12,
      okChecks: index === 20 ? 0 : index < 2 ? 0 : 12,
    }));
    rendered = await render(<ConnectionPage connectionId="conn-1" />, {
      routes: {
        "GET /databases/connections/conn-1": () =>
          json({
            ...detail({ state: "ok", notices: [], lastCheck: null }),
            health: {
              ...connectionFixture().health,
              reachability: "unreachable",
              consecutiveFailures: 3,
              failingSince: "2026-11-17T10:50:00.000Z",
              errorCode: "db_unreachable",
              alerted: true,
            },
            band,
          }),
        "GET /databases/connections/conn-1/health": () =>
          json({
            from: "2026-11-16T11:00:00.000Z",
            to: "2026-11-17T11:00:00.000Z",
            bucketSeconds: 420,
            availability: { day: 0.9583, week: 0.99, month: null },
            points: [
              {
                at: "2026-11-17T10:00:00.000Z",
                checks: 12,
                okChecks: 12,
                latencyMs: 24,
                latencyMaxMs: 40,
                connectionsUsed: 7,
                connectionsMax: 100,
              },
            ],
            events: [
              {
                kind: "unreachable",
                from: "2026-11-17T10:50:00.000Z",
                to: null,
                errorCode: "db_unreachable",
              },
              { kind: "version", at: "2026-11-17T08:00:00.000Z", from: "16.3", to: "16.4" },
            ],
            lastError: {
              at: "2026-11-17T11:00:00.000Z",
              code: "db_unreachable",
              message: "timeout",
            },
          }),
      },
    });
    await flush(5);
    const health = slot("connection-health");
    expect(health?.textContent).toContain("No replacement for monitoring");
    expect(slot("health-now")?.textContent).toContain("3 checks in a row failed since");
    expect(health?.textContent).toContain("The alert");
    const bandSvg = document.querySelector('[data-slot="health-band"]');
    expect(bandSvg?.getAttribute("aria-label")).toBe(
      "Last 24 hours: 21 hours reachable, 1 with outages, 2 without a check.",
    );
    expect(bandSvg?.querySelectorAll("rect")).toHaveLength(24);
    const availability = [...document.querySelectorAll('[data-slot="availability"]')].map(
      (tile) => tile.textContent,
    );
    expect(availability[0]).toContain("95.83");
    expect(availability[2]).toContain("No check");
    const events = slot("health-events")?.textContent ?? "";
    expect(events).toContain("Not reachable since");
    expect(events).toContain("Version 16.3 → 16.4");
    expect(slot("health-last-error")?.textContent).toContain("timeout");
    // Never green: a connection that answers proves nothing about its backups.
    expect(document.querySelector('[data-slot="health-band"] [fill*="success"]')).toBeNull();
  });
});
