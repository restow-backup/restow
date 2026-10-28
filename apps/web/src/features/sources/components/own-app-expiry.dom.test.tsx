// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buttonByText, click, type } from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";

import "../i18n";
import type { OwnAppInfo, SourceDto } from "../types";
import { DetailsList } from "./details-list";
import { OwnAppExpiryAlert, OwnAppExpiryItem, ownAppExpiresAt } from "./own-app-expiry";
import { OwnAppForm } from "./own-app-form";

/**
 * The expiry of a source's own app credential (docs/ENTRA-SETUP.md, "Expiry"): the connect form
 * sends the secret's date with the secret, the connection card shows the badge, warns within 30
 * days and lets an admin note or change the date (PATCH own-app/expiry) without the secret.
 */

vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", role: "tenant_admin" },
    isProviderAdmin: false,
    features: [],
  }),
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: (path: string, init?: unknown) => apiFetch(path, init) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-28T10:00:00.000Z");
const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "66666666-7777-4888-8999-000000000000";

function ownApp(overrides: Partial<OwnAppInfo> = {}): OwnAppInfo {
  return {
    clientId: CLIENT,
    credentialKind: "secret",
    authorityHost: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    updatedBy: "admin@example.com",
    secretExpiresAt: null,
    certificateNotAfter: null,
    ...overrides,
  };
}

function source(app: OwnAppInfo | null): SourceDto {
  return {
    id: "s-1",
    tenantId: "t-1",
    kind: "m365",
    name: "Contoso",
    status: "active",
    errorMessage: null,
    failure: null,
    lastSyncAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    imap: null,
    m365: {
      connectionMode: app ? "own_app" : "consent",
      ownApp: app,
      entraTenantId: app ? TENANT : null,
      entraTenantHint: null,
      consentGrantedAt: null,
      consentBy: null,
      consentError: null,
      permissions: null,
      verification: null,
    },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  apiFetch.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
      </QueryClientProvider>,
    );
  });
}

const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`);
const text = () => (container.textContent ?? "").replace(/\s+/g, " ");

describe("ownAppExpiresAt", () => {
  it("reads the certificate's end for a certificate and the noted date for a secret", () => {
    expect(ownAppExpiresAt(ownApp({ secretExpiresAt: "2027-03-01T00:00:00.000Z" }))).toBe(
      "2027-03-01T00:00:00.000Z",
    );
    expect(
      ownAppExpiresAt(
        ownApp({ credentialKind: "certificate", certificateNotAfter: "2028-01-01T00:00:00.000Z" }),
      ),
    ).toBe("2028-01-01T00:00:00.000Z");
    expect(ownAppExpiresAt(ownApp())).toBeNull();
  });
});

describe("OwnAppForm", () => {
  async function fillAndSubmit(date: string) {
    await type(input("own-app-tenant"), TENANT);
    await type(input("own-app-client"), CLIENT);
    await type(input("own-app-secret"), "s3cr3t-value");
    await type(input("own-app-expires-at"), date);
    await click(buttonByText(container, "Connect with own app"));
  }

  it("sends the secret's expiry date with the secret", async () => {
    apiFetch.mockResolvedValue({ source: source(ownApp()) });
    render(<OwnAppForm source={source(null)} onConnected={() => {}} />);
    expect(input("own-app-expires-at")?.type).toBe("date");
    await fillAndSubmit("2027-03-01");
    expect(apiFetch).toHaveBeenCalledWith("/sources/s-1/own-app", {
      method: "PUT",
      body: {
        tenantId: TENANT,
        clientId: CLIENT,
        credentialKind: "secret",
        clientSecret: "s3cr3t-value",
        secretExpiresAt: "2027-03-01",
      },
    });
  });

  it("sends null without a date (a date input hands over no impossible day)", async () => {
    apiFetch.mockResolvedValue({ source: source(ownApp()) });
    render(<OwnAppForm source={source(null)} onConnected={() => {}} />);
    await fillAndSubmit("2027-02-30");
    expect(apiFetch).toHaveBeenCalledWith(
      "/sources/s-1/own-app",
      expect.objectContaining({ body: expect.objectContaining({ secretExpiresAt: null }) }),
    );
  });

  it("does not carry the old secret's date over to a new one, and has none for a certificate", async () => {
    apiFetch.mockResolvedValue({ source: source(ownApp()) });
    render(
      <OwnAppForm
        source={source(ownApp({ secretExpiresAt: "2026-11-05T00:00:00.000Z" }))}
        onConnected={() => {}}
      />,
    );
    // A rotation: only the new secret is typed in.
    expect(input("own-app-expires-at")?.value).toBe("");
    await type(input("own-app-secret"), "n3w-s3cr3t");
    await click(buttonByText(container, "Replace credentials"));
    expect(apiFetch).toHaveBeenCalledWith(
      "/sources/s-1/own-app",
      expect.objectContaining({
        body: expect.objectContaining({ clientSecret: "n3w-s3cr3t", secretExpiresAt: null }),
      }),
    );
    render(<OwnAppForm source={source(null)} onConnected={() => {}} />);
    await click(buttonByText(container, "Certificate"));
    expect(input("own-app-expires-at")).toBeNull();
  });
});

describe("OwnAppExpiryItem", () => {
  function renderItem(app: OwnAppInfo) {
    render(
      <DetailsList>
        <OwnAppExpiryItem sourceId="s-1" ownApp={app} now={NOW} />
      </DetailsList>,
    );
  }

  it("shows the badge in the tone of its stage", () => {
    const tone = () => container.querySelector("[data-tone]")?.getAttribute("data-tone");
    renderItem(ownApp({ secretExpiresAt: new Date(NOW + 20 * DAY).toISOString() }));
    expect(text()).toContain("Expires in 20 days");
    expect(tone()).toBe("warning");
    renderItem(ownApp({ secretExpiresAt: new Date(NOW + 3 * DAY).toISOString() }));
    expect(tone()).toBe("destructive");
    renderItem(ownApp({ secretExpiresAt: new Date(NOW + 90 * DAY).toISOString() }));
    expect(tone()).toBe("neutral");
  });

  it("asks for the date while it is unknown and saves it without the secret", async () => {
    apiFetch.mockResolvedValue(source(ownApp({ secretExpiresAt: "2027-03-01T00:00:00.000Z" })));
    renderItem(ownApp());
    expect(text()).toContain("Not noted.");
    await click(buttonByText(container, "Note expiry date"));
    await type(input("own-app-expiry-edit"), "2027-03-01");
    await click(buttonByText(container, "Save date"));
    expect(apiFetch).toHaveBeenCalledWith("/sources/s-1/own-app/expiry", {
      method: "PATCH",
      body: { secretExpiresAt: "2027-03-01" },
    });
  });

  it("clears a stored date with null", async () => {
    apiFetch.mockResolvedValue(source(ownApp()));
    renderItem(ownApp({ secretExpiresAt: "2027-03-01T00:00:00.000Z" }));
    await click(buttonByText(container, "Change expiry date"));
    expect(input("own-app-expiry-edit")?.value).toBe("2027-03-01");
    await click(buttonByText(container, "Remove date"));
    expect(apiFetch).toHaveBeenCalledWith("/sources/s-1/own-app/expiry", {
      method: "PATCH",
      body: { secretExpiresAt: null },
    });
  });

  it("reads a refused date under the field", async () => {
    apiFetch.mockRejectedValue(
      new ApiError(422, { type: "about:blank", title: "Validation failed", status: 422 }, "x"),
    );
    renderItem(ownApp());
    await click(buttonByText(container, "Note expiry date"));
    await type(input("own-app-expiry-edit"), "2027-03-01");
    await click(buttonByText(container, "Save date"));
    expect(text()).toContain("Enter a valid date.");
  });

  it("offers no date for a certificate, which carries its own", () => {
    renderItem(
      ownApp({
        credentialKind: "certificate",
        certificateNotAfter: new Date(NOW + 400 * DAY).toISOString(),
      }),
    );
    expect(text()).toContain("Valid until");
    expect(buttonByText(container, "Change expiry date")).toBeNull();
  });
});

describe("OwnAppExpiryAlert", () => {
  it("warns within 30 days, red within 7 and once expired, and is quiet otherwise", () => {
    const variant = () => container.querySelector('[role="alert"]')?.className ?? null;
    render(
      <OwnAppExpiryAlert
        ownApp={ownApp({ secretExpiresAt: new Date(NOW + 40 * DAY).toISOString() })}
        now={NOW}
      />,
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    render(
      <OwnAppExpiryAlert
        ownApp={ownApp({ secretExpiresAt: new Date(NOW + 20 * DAY).toISOString() })}
        now={NOW}
      />,
    );
    expect(text()).toContain("expires soon");
    expect(variant()).not.toContain("destructive");
    render(
      <OwnAppExpiryAlert
        ownApp={ownApp({ secretExpiresAt: new Date(NOW - DAY).toISOString() })}
        now={NOW}
      />,
    );
    expect(text()).toContain("has expired");
    expect(variant()).toContain("destructive");
  });
});
