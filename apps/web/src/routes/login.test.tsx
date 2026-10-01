import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { ThemeProvider } from "@/components/theme-provider";
import { i18n } from "@/i18n";
import { type SetupState, queryKeys } from "@/lib/api";
import { LoginPage } from "@/routes/login";
import { rootRoute } from "@/routes/tree";

/**
 * The login page rendered to static markup through the real route tree (the
 * root guard needs it): the ordinary emergency sign-in, and the public
 * demo's panel (deploy/demo/README.md) that appears only when the
 * installation reports a demo account.
 */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const loginSearchSchema = z.object({
  redirect: z.string().optional(),
  error: z.string().optional(),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (search: Record<string, unknown>) => loginSearchSchema.parse(search),
  component: LoginPage,
});

const routeTree = rootRoute.addChildren([loginRoute]);

const baseSetupState: SetupState = {
  configured: true,
  productName: "Restow",
  operatingMode: "public",
  publicUrl: "https://restow.example.test",
  passkeyReady: { ready: false, reasons: ["mode_not_public"], rpId: null, origin: null },
  mailTransport: "smtp",
  disclaimer: { version: "2026-09-30", accepted: true },
  setupToken: { required: false, source: null },
  microsoftSignIn: false,
  demo: { enabled: false, email: null, password: null },
};

async function renderLogin(setupState: SetupState): Promise<string> {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.setupState, setupState);
  queryClient.setQueryData(queryKeys.authSession, null);

  const router = createRouter({
    routeTree,
    context: { queryClient, navItems: [] },
    history: createMemoryHistory({ initialEntries: ["/login"] }),
  });
  await router.load();

  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>
    </I18nextProvider>,
  );
}

describe("login page", () => {
  it("shows only the emergency sign-in when demo mode is off", async () => {
    const html = await renderLogin(baseSetupState);
    expect(html).toContain("Emergency sign-in");
    expect(html).not.toContain("Public demo");
    expect(html).not.toContain("Sign in to the demo");
  });

  it("shows the demo panel with the prefilled credentials and a one-click sign-in", async () => {
    const html = await renderLogin({
      ...baseSetupState,
      demo: { enabled: true, email: "demo@example.org", password: "correct horse battery staple" },
    });
    expect(html).toContain("Public demo");
    expect(html).toContain("demo@example.org");
    expect(html).toContain("correct horse battery staple");
    expect(html).toContain("Sign in to the demo");
  });

  it("hides the demo panel when demo mode is on but a credential is missing", async () => {
    const html = await renderLogin({
      ...baseSetupState,
      demo: { enabled: true, email: null, password: null },
    });
    expect(html).not.toContain("Public demo");
  });
});
