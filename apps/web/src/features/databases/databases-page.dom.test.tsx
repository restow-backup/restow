// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "./i18n.js";
import { DatabasesPage } from "./databases-page.js";
import {
  action,
  connectionFixture,
  databaseFixture,
  FINGERPRINT,
  probeFixture,
  type Rendered,
  render,
  sessionWithRole,
  slot,
  text,
} from "./testing.js";

/**
 * The Databases page as an administrator goes through it (docs/DATABASES.md 2.3, 3): the list,
 * the suggestions of the inventory, "Add database" that tests before it saves (engine, version,
 * certificate, rights matrix with the grant SQL), and the credentials that go out once and never
 * come back.
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

function field(label: string): HTMLInputElement {
  const element = [...document.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const input = element ? document.getElementById(element.htmlFor) : null;
  if (!input) throw new Error(`no field "${label}"`);
  return input as HTMLInputElement;
}

const baseRoutes = {
  "GET /databases": () =>
    json({
      databases: [
        databaseFixture({
          reachability: "slow",
          band: Array.from({ length: 24 }, (_, index) => ({
            at: new Date(Date.UTC(2026, 10, 16, 12 + index)).toISOString(),
            state: index === 23 ? "slow" : "ok",
            checks: 12,
            okChecks: 12,
          })),
        }),
      ],
    }),
  "GET /databases/connections": () => json({ connections: [connectionFixture()] }),
  "GET /databases/suggestions": () =>
    json({
      suggestions: [
        {
          endpointId: "ep-1",
          hostname: "db-host",
          engine: "postgresql",
          name: "16/main",
          version: "16",
          source: "pg_lsclusters",
          port: 5432,
          container: null,
          running: true,
          prefill: { address: "localhost:5432", authMethod: "socket", endpointId: "ep-1" },
          collectedAt: "2026-11-17T10:00:00Z",
        },
      ],
    }),
  "GET /databases/runners": () =>
    json({
      runners: [
        { endpointId: "ep-1", hostname: "db-host", os: "linux", online: true, lastSeenAt: null },
      ],
    }),
};

describe("the Databases page", () => {
  it("lists the databases, the connections and what the inventory found, without green", async () => {
    rendered = await render(<DatabasesPage adding={false} onAddChange={() => undefined} />, {
      routes: baseRoutes,
    });
    expect(slot("databases-page")).not.toBeNull();
    expect(text()).toContain("erp");
    expect(text()).toContain("Not backed up yet");
    expect(text()).toContain("PostgreSQL");
    // Reachability from the health checks, with the band of the last 24 hours (8).
    expect(text()).toContain("Slow");
    expect(slot("health-band")?.getAttribute("aria-label")).toBe(
      "Last 24 hours: 24 hours reachable, 0 with outages, 0 without a check.",
    );
    expect(slot("database-connections")?.textContent).toContain("Sign-in works");
    expect(slot("database-suggestions")?.textContent).toContain("PostgreSQL 16/main on db-host");
    expect(document.querySelector('[data-tone="success"], .bg-success, .text-success')).toBeNull();
  });

  it("lets a restore operator read, without adding or seeing the suggestions", async () => {
    rendered = await render(<DatabasesPage adding={false} onAddChange={() => undefined} />, {
      routes: baseRoutes,
      session: sessionWithRole("tenant_restore"),
    });
    expect(text()).toContain("erp");
    expect(action("add-database")).toBeNull();
    expect(slot("database-suggestions")).toBeNull();
    expect(
      rendered.requests.some((request) => request.path.startsWith("/databases/suggestions")),
    ).toBe(false);
  });

  it("tests before it saves, moves URL credentials into their fields and shows what the user allows", async () => {
    let created: Record<string, unknown> | null = null;
    let tested: Record<string, unknown> | null = null;
    rendered = await render(<DatabasesPage adding onAddChange={() => undefined} />, {
      routes: {
        ...baseRoutes,
        "POST /databases/connections/test": (request) => {
          tested = request.body as Record<string, unknown>;
          return json(probeFixture());
        },
        "GET /databases/connections/test/probe-1": () => json(probeFixture()),
        "POST /databases/connections": (request) => {
          created = request.body as Record<string, unknown>;
          return json(connectionFixture(), 201);
        },
      },
    });
    expect(slot("add-database")).not.toBeNull();
    const save = action("save-connection") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const address = field("Address");
    await type(address, "postgresql://backup:s3cret@db.example.com/erp");
    address.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    address.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await flush(3);
    expect(field("Address").value).toBe("postgresql://db.example.com/erp");
    expect(field("User").value).toBe("backup");
    expect(field("Password").value).toBe("s3cret");

    await click(action("test-connection") as HTMLElement);
    await flush(10);
    expect(tested).toMatchObject({
      address: "postgresql://db.example.com/erp",
      user: "backup",
      password: "s3cret",
      executor: { kind: "server" },
      allowUnencrypted: false,
    });
    expect(slot("probe-engine")?.textContent).toContain("PostgreSQL 16.4");
    expect(slot("probe-fingerprint")?.textContent).toBe(FINGERPRINT);
    const matrix = slot("rights-matrix");
    expect(matrix?.textContent).toContain("Backup");
    expect(matrix?.textContent).toContain("CREATEDB");
    expect(slot("grant-sql")?.textContent).toContain("GRANT pg_read_all_data TO restow_backup;");
    expect(slot("probe-databases")?.textContent).toContain("shop");

    expect((action("save-connection") as HTMLButtonElement).disabled).toBe(false);
    await click(action("save-connection") as HTMLElement);
    await flush(10);
    expect(created).toMatchObject({
      probeId: "probe-1",
      user: "backup",
      password: "s3cret",
      mode: "backup",
      schedule: { intervalMinutes: 60 },
    });
    expect(rendered.where().pathname).toBe("/databases/connections/conn-1");
  });

  it("waits for an agent, and offers the socket sign-in only for a Linux agent", async () => {
    let polls = 0;
    rendered = await render(<DatabasesPage adding onAddChange={() => undefined} />, {
      routes: {
        ...baseRoutes,
        "POST /databases/connections/test": () =>
          json(probeFixture({ status: "pending", engine: null, rights: null, databases: [] }), 202),
        "GET /databases/connections/test/probe-1": () => {
          polls += 1;
          return json(
            probeFixture({ status: "pending", engine: null, rights: null, databases: [] }),
          );
        },
      },
    });
    expect(text()).not.toContain("Sign in over the local socket");
    const executor = document.getElementById("db-executor") as HTMLSelectElement;
    executor.value = "ep-1";
    executor.dispatchEvent(new Event("change", { bubbles: true }));
    await flush(3);
    expect(text()).toContain("Sign in over the local socket");
    await type(field("Address"), "10.0.0.5:5432");
    await click(buttonByText(document, "Test connection") as HTMLElement);
    await flush(10);
    expect(slot("probe-waiting")?.textContent).toContain("The agent is testing the connection");
    expect(polls).toBeGreaterThan(0);
    expect((action("save-connection") as HTMLButtonElement).disabled).toBe(true);
  });
});
