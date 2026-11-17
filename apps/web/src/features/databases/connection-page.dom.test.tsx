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
});
