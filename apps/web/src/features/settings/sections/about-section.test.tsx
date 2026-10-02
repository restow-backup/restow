import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { resetWebExtensionsForTesting } from "@/lib/extensions";
import {
  type RunningVersion,
  type SessionContextValue,
  StaticSessionProvider,
} from "@/lib/session";

import "../i18n";
import { AboutSection } from "./about-section";

/**
 * Installation, About: the facts of the running build and where its license,
 * source code and third-party notices are, for a release and for a
 * development build. Nothing about an edition or a license key: that is a
 * section of its own where an extension offers one.
 */

const REPOSITORY = "https://github.com/restow-backup/restow";

const release: RunningVersion = {
  running: "0.1.0",
  commit: "4f2a9c1",
  latest: null,
  updateAvailable: false,
  releaseUrl: null,
};

function session(version: RunningVersion | null): SessionContextValue {
  return {
    status: "authenticated",
    user: { id: "u1", name: "Owner", email: "owner@example.test" },
    role: "provider_admin",
    features: [],
    extensions: {},
    isProviderAdmin: true,
    tenants: [],
    activeTenant: null,
    setActiveTenant: () => undefined,
    version,
    signOut: async () => undefined,
    refresh: async () => undefined,
    error: null,
  };
}

function render(version: RunningVersion | null): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <StaticSessionProvider value={session(version)}>
        <AboutSection />
      </StaticSessionProvider>
    </I18nextProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  resetWebExtensionsForTesting();
});

describe("AboutSection", () => {
  it("names product, version and commit of a release and links its tag", () => {
    const html = render(release);
    expect(html).toContain("About Restow");
    expect(html).toContain(">Restow<");
    expect(html).toContain(">0.1.0<");
    expect(html).toContain(">4f2a9c1<");
    expect(html).toContain('href="https://www.apache.org/licenses/LICENSE-2.0"');
    expect(html).toContain("Apache-2.0");
    expect(html).toContain(`href="${REPOSITORY}/tree/v0.1.0"`);
    expect(html).toContain("Source code of version 0.1.0");
    expect(html).toContain('href="/licenses/THIRD_PARTY_NOTICES.txt"');
    expect(html).toContain("Third-party notices");
    expect(html).toContain(`href="${REPOSITORY}/blob/v0.1.0/THIRD_PARTY_NOTICES.md"`);
    expect(html).toContain("on GitHub");
    expect(html).toContain('target="_blank"');
    expect(html).toContain("(opens in a new tab)");
  });

  it("links the repository and main for a development build", () => {
    const html = render({ ...release, running: null, commit: null });
    expect(html).toContain("Development build");
    expect(html).toContain("Unknown");
    expect(html).toContain(`href="${REPOSITORY}"`);
    expect(html).toContain("Source code repository");
    expect(html).toContain(`href="${REPOSITORY}/blob/main/THIRD_PARTY_NOTICES.md"`);
    expect(html).toContain('href="/licenses/THIRD_PARTY_NOTICES.txt"');
    expect(html).not.toContain("/tree/");
  });

  it("treats a profile without a version block as a development build", () => {
    const html = render(null);
    expect(html).toContain("Development build");
    expect(html).toContain(`href="${REPOSITORY}"`);
  });

  it("explains no license rights and names no edition", () => {
    const html = render(release);
    expect(html).not.toMatch(
      /edition|Community|Business|Service Provider|AGPL|fair|free of charge|never limited/i,
    );
  });
});
