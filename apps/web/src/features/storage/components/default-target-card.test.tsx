import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { sessionAs } from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { StaticSessionProvider } from "@/lib/session";

import "../i18n";
import type { InstallationDefaultDto, StorageTargetDto } from "../types";
import { DefaultTargetCard, backToDefault } from "./default-target-card";

/**
 * The installation default as an explicit choice on a tenant's storage page
 * (docs/STORAGE.md, "Installation default"): selected while the tenant has no
 * primary of its own, otherwise shown as not in use, with the way back offered
 * only while the tenant's own primary holds no data.
 */

const DEFAULT: InstallationDefaultDto = {
  inUse: true,
  kind: "local",
  location: "/data/chunks",
  hasCopy: false,
  copyLocation: null,
  misconfigured: false,
};

const PRIMARY = {
  id: "8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d",
  name: "Offsite",
  kind: "s3",
  role: "primary",
  canManage: true,
  migration: null,
} as unknown as StorageTargetDto;

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <StaticSessionProvider value={sessionAs({})}>{node}</StaticSessionProvider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("backToDefault", () => {
  it("offers the way back only while the own primary holds no data", () => {
    expect(backToDefault({ primary: PRIMARY, tenantHasData: false })).toBe("available");
    expect(backToDefault({ primary: PRIMARY, tenantHasData: true })).toBe("blocked");
    expect(backToDefault({ primary: null, tenantHasData: false })).toBe("none");
  });

  it("does not offer it to a viewer who may not remove the primary, or during a migration", () => {
    expect(backToDefault({ primary: { ...PRIMARY, canManage: false }, tenantHasData: false })).toBe(
      "none",
    );
    expect(
      backToDefault({
        primary: {
          ...PRIMARY,
          migration: { status: "copying" } as StorageTargetDto["migration"],
        },
        tenantHasData: false,
      }),
    ).toBe("none");
  });
});

describe("DefaultTargetCard", () => {
  it("marks the default as selected while the tenant has no primary of its own", () => {
    const html = render(
      <DefaultTargetCard installationDefault={DEFAULT} primary={null} tenantHasData={false} />,
    );
    expect(html).toContain('data-in-use="true"');
    expect(html).toContain("Selected: new backups of this tenant go here.");
    expect(html).not.toContain("Use installation default");
  });

  it("shows it as not in use, with the way back, next to an empty own primary", () => {
    const html = render(
      <DefaultTargetCard
        installationDefault={{ ...DEFAULT, inUse: false }}
        primary={PRIMARY}
        tenantHasData={false}
      />,
    );
    expect(html).toContain('data-in-use="false"');
    expect(html).toContain("Not in use");
    expect(html).toContain("Use installation default");
  });

  it("explains why there is no way back once the own primary holds backups", () => {
    const html = render(
      <DefaultTargetCard
        installationDefault={{ ...DEFAULT, inUse: false }}
        primary={PRIMARY}
        tenantHasData
      />,
    );
    expect(html).not.toContain("Use installation default");
    expect(html).toContain("Going back to the installation default is not possible");
  });
});
