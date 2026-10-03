// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdatesView } from "@/features/updates/api";
import {
  type Mounted,
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  json,
  mount,
  routedFetch,
  updatesFixture,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { registerWebExtension, resetWebExtensionsForTesting } from "@/lib/extensions";

import { EDITION_SECTION, installationSections } from "../sections";
import { EditionContent } from "./edition-section";

/**
 * Installation, Edition on the Community build: what it says, the switch through the
 * updater or by hand, and the license key kept for the full build.
 */

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const COMMUNITY: UpdatesView["edition"] = {
  build: "community",
  pendingLicenseKey: false,
  fullImages: {
    app: "ghcr.io/restow-backup/restow:0.1.0",
    web: "ghcr.io/restow-backup/restow-web:0.1.0",
  },
};

function show(view: UpdatesView, canManage = true): HTMLElement {
  mounted = mount(<EditionContent view={view} canManage={canManage} />);
  return mounted.container;
}

function text(scope: ParentNode = document.body): string {
  return (scope.textContent ?? "").replace(/\s+/g, " ").trim();
}

function slot(name: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-slot="${name}"]`);
}

describe("where the Edition section appears", () => {
  it("is a section of the Community build only: the full build keeps its License section", () => {
    expect(installationSections().map((spec) => spec.id)).toContain(EDITION_SECTION.id);
    registerWebExtension({
      name: "license-test",
      installationSections: [{ ...EDITION_SECTION, id: "license", labelKey: "x:license" }],
    });
    try {
      const ids = installationSections().map((spec) => spec.id);
      expect(ids).toContain("license");
      expect(ids).not.toContain("edition");
    } finally {
      resetWebExtensionsForTesting();
    }
  });
});

describe("the Edition section", () => {
  it("names the build and what the full build adds", () => {
    show(updatesFixture({ edition: COMMUNITY }));
    expect(text()).toContain("This installation runs the Community build");
    expect(text(slot("edition-adds") as HTMLElement)).toContain("Service Provider");
  });

  it("switches through the updater: lead time, signature check, then the request", async () => {
    const { mock, requests } = routedFetch({
      "POST /updates/edition/switch": () =>
        json(
          updatesFixture({
            edition: COMMUNITY,
            updater: { ...updatesFixture().updater, state: "busy" },
          }),
        ),
    });
    vi.stubGlobal("fetch", mock);
    show(updatesFixture({ edition: COMMUNITY }));
    expect(slot("edition-switch")?.dataset.path).toBe("updater");
    await click(buttonByText(document.body, "Switch to the full build"));
    expect(text()).toContain("checked against the signature of the release workflow");
    await click(buttonByText(document.body, "Announce the switch"));
    await flush();
    expect(requests).toEqual([
      { method: "POST", path: "/updates/edition/switch", body: { leadSeconds: 300 } },
    ]);
  });

  it("shows the two .env lines and the commands when the updater does not run", () => {
    show(
      updatesFixture({
        edition: COMMUNITY,
        updater: { ...updatesFixture().updater, state: "unavailable", version: null },
      }),
    );
    expect(slot("edition-switch")?.dataset.path).toBe("manual");
    const manual = text(slot("edition-manual") as HTMLElement);
    expect(manual).toContain("RESTOW_IMAGE=ghcr.io/restow-backup/restow:0.1.0");
    expect(manual).toContain("RESTOW_WEB_IMAGE=ghcr.io/restow-backup/restow-web:0.1.0");
    expect(manual).toContain("docker compose pull && docker compose up -d");
    expect(manual).toContain("docker compose --profile updater up -d");
    expect(buttonByText(document.body, "Switch to the full build")).toBeNull();
  });

  it("switches by hand for an installation built from a custom source", () => {
    show(updatesFixture({ edition: COMMUNITY, mode: "source" }));
    expect(slot("edition-switch")?.dataset.path).toBe("manual");
  });

  it("stores a license key, honest that it is checked only after the switch", async () => {
    const { mock, requests } = routedFetch({
      "PUT /updates/edition/license-key": () =>
        json(updatesFixture({ edition: { ...COMMUNITY, pendingLicenseKey: true } })),
    });
    vi.stubGlobal("fetch", mock);
    show(updatesFixture({ edition: COMMUNITY }));
    expect(text()).toContain("checked and applied after the switch to the full build");
    const field = document.body.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        field,
        "restow-license-v1.abc.def",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await click(buttonByText(document.body, "Store key"));
    await flush();
    expect(requests).toEqual([
      {
        method: "PUT",
        path: "/updates/edition/license-key",
        body: { key: "restow-license-v1.abc.def" },
      },
    ]);
  });

  it("says when a key is stored, and offers to remove it", () => {
    show(updatesFixture({ edition: { ...COMMUNITY, pendingLicenseKey: true } }));
    expect(text(slot("edition-key-stored") as HTMLElement)).toContain(
      "checked and applied after switching to the full build",
    );
    expect(buttonByText(document.body, "Remove key")).not.toBeNull();
  });

  it("changes nothing for a provider team role below owner", () => {
    show(updatesFixture({ edition: COMMUNITY }), false);
    expect(buttonByText(document.body, "Switch to the full build")?.disabled).toBe(true);
    expect(document.body.querySelector("textarea")?.disabled).toBe(true);
  });

  it("tells a page that is older than the server's build to reload", () => {
    show(updatesFixture({ edition: { ...COMMUNITY, build: "full" } }));
    expect(text(slot("edition-switched") as HTMLElement)).toContain("Reload this page");
  });
});
