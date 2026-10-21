// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { VersionUpdateButton } from "./app-sidebar";

/**
 * The version in the sidebar footer as the way to an update (0.4.2): a highlighted link "Update
 * to X available" to Installation, Updates; accent colour (never green), breathing only when
 * the person allows motion; nothing without an update.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      search: _search,
      ...props
    }: {
      to: string;
      search?: unknown;
      children: React.ReactNode;
    }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const render = (version: Parameters<typeof VersionUpdateButton>[0]["version"]) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <VersionUpdateButton version={version} />
    </I18nextProvider>,
  );

describe("VersionUpdateButton", () => {
  it("leads to Installation, Updates when a newer release is available", () => {
    const html = render({
      running: "0.4.1",
      latest: "0.4.2",
      updateAvailable: true,
      releaseUrl: "https://example.test/releases/v0.4.2",
    } as never);
    const host = document.createElement("div");
    host.innerHTML = html;
    const link = host.querySelector<HTMLAnchorElement>('[data-slot="version-update"]');
    expect(link?.textContent).toBe("Update to 0.4.2 available");
    expect(link?.getAttribute("href")).toBe("/installation/updates");
    expect(link?.getAttribute("title")).toBe("Version 0.4.1");
    const classes = link?.className ?? "";
    // Accent (info), not green; the pulse only with motion allowed.
    expect(classes).toContain("text-info-text");
    expect(classes).not.toMatch(/success|green|emerald/);
    expect(classes).toContain("motion-safe:animate-update-pulse");
    expect(classes).not.toMatch(/(^|\s)animate-/);
  });

  it("renders nothing without an update", () => {
    expect(
      render({
        running: "0.4.2",
        latest: "0.4.2",
        updateAvailable: false,
        releaseUrl: null,
      } as never),
    ).toBe("");
    expect(render(null)).toBe("");
  });
});
