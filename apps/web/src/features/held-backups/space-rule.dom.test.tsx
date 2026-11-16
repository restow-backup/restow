// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  json,
  type Mounted,
  mount,
  routedFetch,
  type,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { TargetSpaceRuleLine } from "./space-rule";

/**
 * What one of a tenant's own storage targets keeps free (#99, docs/STORAGE.md "Unusually large
 * runs"), on its card on the storage page: the rule that applies, whether it is the target's own,
 * and the dialog that changes it or goes back to the tenant's and the installation's rule.
 */

enableActEnvironment();

const GIB = 1024 ** 3;
const TARGET = "8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d";
const RULE = { enabled: true, percent: 5, minBytes: 20 * GIB, maxBytes: 500 * GIB };
let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const text = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

describe("the space rule on a storage target's card", () => {
  it("shows what the target keeps free and saves its own rule", async () => {
    const fetch = routedFetch({
      "GET /run-size/targets": () =>
        json([{ targetId: TARGET, name: "NAS", role: "primary", override: null, effective: RULE }]),
      [`PUT /run-size/targets/${TARGET}`]: () =>
        json([
          {
            targetId: TARGET,
            name: "NAS",
            role: "primary",
            override: { enabled: false },
            effective: { ...RULE, enabled: false },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetch.mock);
    mounted = mount(<TargetSpaceRuleLine targetId={TARGET} tenantId="t-1" canEdit />);
    await flush(4);
    expect(text()).toContain("Kept free for other data:");
    expect(text()).toContain("Keeps 5 % of the target free, at least 20 GB, at most 500 GB");
    expect(text()).not.toContain("own rule");
    await click(buttonByText(document.body, "Change"));
    await flush(2);
    const dialog = document.querySelector('[data-slot="space-rule-dialog"]') as HTMLElement;
    // No own rule yet: nothing to go back from.
    expect(buttonByText(dialog, "Use the general rule")).toBeNull();
    await click(dialog.querySelector('[role="checkbox"]'));
    await click(buttonByText(dialog, "Save"));
    await flush(4);
    // Only what was changed becomes the target's own.
    expect(fetch.requests.find((request) => request.method === "PUT")).toEqual({
      method: "PUT",
      path: `/run-size/targets/${TARGET}`,
      body: { space: { enabled: false } },
    });
    expect(text()).toContain("Off: no space is kept free");
    expect(text()).toContain("own rule");
  });

  it("refuses an at most below the at least, and shows nothing for a target not listed", async () => {
    const fetch = routedFetch({
      "GET /run-size/targets": () =>
        json([{ targetId: TARGET, name: "NAS", role: "primary", override: null, effective: RULE }]),
    });
    vi.stubGlobal("fetch", fetch.mock);
    mounted = mount(<TargetSpaceRuleLine targetId={TARGET} tenantId="t-1" canEdit />);
    await flush(4);
    await click(buttonByText(document.body, "Change"));
    await flush(2);
    const dialog = document.querySelector('[data-slot="space-rule-dialog"]') as HTMLElement;
    const most = [...dialog.querySelectorAll("label")].find((label) =>
      label.textContent?.includes("At most (GiB)"),
    );
    await type(document.getElementById(most?.getAttribute("for") ?? ""), "5");
    expect(buttonByText(dialog, "Save")?.disabled).toBe(true);
    await mounted.unmount();
    mounted = mount(<TargetSpaceRuleLine targetId="another" tenantId="t-1" canEdit />);
    await flush(4);
    expect(document.querySelector('[data-slot="target-space-rule"]')).toBeNull();
  });
});
