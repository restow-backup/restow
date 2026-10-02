// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { type Mounted, enableActEnvironment, mount, sessionAs } from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { SetInInstallation } from "./set-in-installation";

/**
 * "Set in the installation" under a value the installation owns: a link into the
 * installation page for a provider admin, whom to ask for everyone else.
 */

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

describe("SetInInstallation", () => {
  it("links a provider admin to the section that holds the value", async () => {
    const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } = await import(
      "@tanstack/react-router"
    );
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => <SetInInstallation to="/installation/server" sectionLabel="Server" />,
      }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    mounted = mount(<RouterProvider router={router} />);
    await mounted.render(<RouterProvider router={router} />);
    const slot = document.querySelector('[data-slot="set-in-installation"]');
    expect(slot?.textContent).toContain("Set in the installation");
    expect(slot?.querySelector("a")?.getAttribute("href")).toBe("/installation/server");
  });

  it("tells everyone else whom to ask, without a link to a page they cannot open", async () => {
    mounted = mount(<SetInInstallation to="/installation/server" sectionLabel="Server" />, {
      session: sessionAs({ isProviderAdmin: false, providerRole: null, role: "tenant_admin" }),
    });
    await mounted.render(<SetInInstallation to="/installation/server" sectionLabel="Server" />);
    const slot = document.querySelector('[data-slot="set-in-installation"]');
    expect(slot?.textContent).toContain("Set in the installation");
    expect(slot?.querySelector("a")).toBeNull();
  });
});
