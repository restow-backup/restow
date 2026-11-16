// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  type Mounted,
  mount,
  problem,
  routedFetch,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import type { BrandingDto, ProviderBrandingView } from "./api";
import { BrandingSection } from "./branding-section";

/**
 * Installation › Branding: below Business it says which edition adds it and offers no form; the
 * logo is checked for type and size before it is uploaded (no SVG, nothing over 512 KiB); an
 * accent colour without enough contrast keeps the save closed; Microsoft 365 keeps the From
 * locked; the preview shows the mail's HTML in a frame without any permission.
 */

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const EMPTY: BrandingDto = {
  senderName: null,
  fromAddress: null,
  replyTo: null,
  accentColor: null,
  onAccent: null,
  footerText: null,
  logo: null,
  updatedAt: null,
};

function view(over: Partial<ProviderBrandingView> = {}): ProviderBrandingView {
  return {
    available: { provider: true, tenant: false, customerReport: false },
    productName: "Restow",
    provider: EMPTY,
    mail: {
      transport: "smtp",
      fromLocked: false,
      defaultFrom: "backup@provider.example",
      allowedSenders: ["@brand.example"],
    },
    publicUrl: "https://backup.provider.example",
    publicUrlHttps: true,
    ...over,
  };
}

const PREVIEW_HTML =
  '<!doctype html><html><body><img src="/api/v1/public/branding/abc.png" alt="Muster IT"><p>Backup failed</p></body></html>';

async function open(
  branding: ProviderBrandingView = view(),
  routes: Parameters<typeof routedFetch>[0] = {},
) {
  const { mock, requests } = routedFetch({
    "GET /settings/branding": () => json(branding),
    "GET /settings/branding/preview": () =>
      json({ subject: "Backup failed: Contoso", html: PREVIEW_HTML, text: "Backup failed" }),
    "GET /setup/state": () => json({ demo: { enabled: false } }),
    ...routes,
  });
  vi.stubGlobal("fetch", mock);
  mounted = mount(<BrandingSection />);
  await flush(8);
  return { requests };
}

const fileInput = () => document.querySelector<HTMLInputElement>("#branding-logo-file");

async function choose(file: File) {
  const input = fileInput();
  if (!input) throw new Error("no file input");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await flush(4);
}

const saveButton = () => document.querySelector<HTMLButtonElement>("[data-slot=branding-save]");

describe("BrandingSection", () => {
  it("shows the edition lock and no form where the edition does not include branding", async () => {
    const { requests } = await open(
      view({ available: { provider: false, tenant: false, customerReport: false } }),
    );
    const locked = document.querySelector("[data-slot=branding-locked]");
    expect(locked?.textContent).toContain("Without it, messages carry Restow only.");
    expect(locked?.querySelector("[data-slot=feature-locked]")?.getAttribute("data-feature")).toBe(
      "branding.provider",
    );
    expect(document.querySelector("[data-slot=branding-editor]")).toBeNull();
    expect(requests.some((request) => request.path.endsWith("/preview"))).toBe(false);
  });

  it("refuses an SVG and a file over 512 KiB before uploading, and uploads a PNG", async () => {
    const { requests } = await open(view(), {
      "PUT /settings/branding/logo": () =>
        json({
          url: "/api/v1/public/branding/abc.png",
          contentType: "image/png",
          width: 200,
          height: 60,
          bytes: 2048,
        }),
    });
    await choose(new File(["<svg onload='alert(1)'/>"], "logo.svg", { type: "image/svg+xml" }));
    expect(document.querySelector("[data-slot=branding-logo-error]")?.textContent).toContain(
      "SVG is not accepted",
    );
    await choose(new File([new Uint8Array(512 * 1024 + 1)], "big.png", { type: "image/png" }));
    expect(document.querySelector("[data-slot=branding-logo-error]")?.textContent).toContain(
      "at most 512 KiB",
    );
    await choose(new File(["gif"], "logo.gif", { type: "image/gif" }));
    expect(document.querySelector("[data-slot=branding-logo-error]")?.textContent).toContain(
      "Only PNG and JPEG",
    );
    expect(requests.filter((request) => request.method === "PUT")).toEqual([]);

    await choose(new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" }));
    expect(requests.filter((request) => request.method === "PUT").map((r) => r.path)).toEqual([
      "/settings/branding/logo",
    ]);
    expect(document.querySelector("[data-slot=branding-logo-error]")).toBeNull();
  });

  it("words the server's refusal of an image", async () => {
    await open(view(), {
      "PUT /settings/branding/logo": () =>
        problem("urn:restow:problem:invalid-image", 422, { code: "animated", field: "logo" }),
    });
    await choose(new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" }));
    expect(document.querySelector("[data-slot=branding-logo-error]")?.textContent).toContain(
      "Animated images are not accepted.",
    );
  });

  it("keeps the save closed while the accent colour fails the contrast check", async () => {
    const { requests } = await open(view(), {
      "PUT /settings/branding": (request) => json({ ...EMPTY, ...(request.body as object) }),
    });
    const accent = document.querySelector<HTMLInputElement>("#branding-accent");
    await type(accent, "#777777");
    await flush(2);
    const ratios = [...document.querySelectorAll("[data-slot=branding-contrast-ratio]")];
    expect(ratios.map((badge) => badge.getAttribute("data-pass"))).toEqual(["false", "false"]);
    expect(document.querySelector("[data-slot=branding-contrast]")?.textContent).toContain(
      "Saving is not possible with this colour.",
    );
    expect(saveButton()?.disabled).toBe(true);

    await type(accent, "#2B4C9B");
    await flush(2);
    expect(
      [...document.querySelectorAll("[data-slot=branding-contrast-ratio]")][0]?.getAttribute(
        "data-pass",
      ),
    ).toBe("true");
    expect(saveButton()?.disabled).toBe(false);
    await click(saveButton());
    await flush(4);
    expect(requests.find((request) => request.method === "PUT")?.body).toEqual({
      senderName: null,
      fromAddress: null,
      replyTo: null,
      accentColor: "#2b4c9b",
      footerText: null,
    });
  });

  it("checks the From against the allowed senders, and shows the server's refusal by field", async () => {
    await open(view(), {
      "PUT /settings/branding": () =>
        problem("urn:restow:problem:invalid-branding", 422, {
          code: "sender-not-allowed",
          field: "fromAddress",
        }),
    });
    const from = document.querySelector<HTMLInputElement>("#branding-from");
    await type(from, "someone@elsewhere.example");
    await flush(2);
    expect(document.body.textContent).toContain("This From address is not allowed yet.");
    expect(saveButton()?.disabled).toBe(true);
    await type(from, "noreply@brand.example");
    await flush(2);
    expect(saveButton()?.disabled).toBe(false);
    await click(saveButton());
    await flush(4);
    expect(from?.getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain("This From address is not allowed yet.");
  });

  it("locks the From for Microsoft 365 and says why", async () => {
    await open(
      view({
        mail: {
          transport: "graph",
          fromLocked: true,
          defaultFrom: "backup@provider.example",
          allowedSenders: [],
        },
      }),
    );
    const from = document.querySelector<HTMLInputElement>("#branding-from");
    expect(from?.disabled).toBe(true);
    expect(from?.value).toBe("backup@provider.example");
    expect(document.body.textContent).toContain(
      "Microsoft 365 and Google Workspace always send from backup@provider.example.",
    );
  });

  it("shows the preview in a frame without any permission", async () => {
    await open(view({ provider: { ...EMPTY, updatedAt: "2026-11-05T10:00:00.000Z" } }));
    const frame = document.querySelector<HTMLIFrameElement>("[data-slot=branding-preview-frame]");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toBe(PREVIEW_HTML);
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(document.querySelector("[data-slot=branding-preview-subject]")?.textContent).toBe(
      "Backup failed: Contoso",
    );
    const tabs = [...document.querySelectorAll("[role=tab]")].map((tab) => tab.textContent);
    expect(tabs).toEqual(["Alert", "Digest", "Summary report"]);
  });

  it("offers the customer report preview where it exists, and notes a missing https address", async () => {
    await open(
      view({
        available: { provider: true, tenant: true, customerReport: true },
        publicUrl: "http://backup.local",
        publicUrlHttps: false,
      }),
    );
    expect(document.querySelector("[data-slot=branding-https-note]")?.textContent).toContain(
      "Logo in Discord and Teams needs a public HTTPS address.",
    );
    const tabs = [...document.querySelectorAll("[role=tab]")].map((tab) => tab.textContent);
    expect(tabs).toContain("Customer report");
  });
});
