import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { sessionAs } from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { StaticSessionProvider } from "@/lib/session";

import "../i18n";
import type { ImmutabilityDto, StorageTargetDto } from "../types";
import { ImmutabilitySection } from "./immutability-section";

/**
 * The immutability of a repository on its card: Object Lock in words, the
 * warnings of the last verification, and a directory's deletion delay called
 * what it is, never immutability. Rendered as static markup, in English.
 */

function immutability(overrides: Partial<ImmutabilityDto> = {}): ImmutabilityDto {
  return {
    mode: "compliance",
    days: 30,
    kind: "object_lock",
    since: "2026-10-01T00:00:00.000Z",
    renewalBufferDays: 7,
    renewedAt: null,
    renewalOverdue: false,
    renewal: null,
    verification: null,
    deferredDeletions: 0,
    history: [],
    canLower: false,
    ...overrides,
  };
}

function target(overrides: Partial<StorageTargetDto>): StorageTargetDto {
  return {
    id: "8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d",
    name: "Offsite",
    kind: "s3",
    role: "copy",
    canManage: true,
    objectLock: { status: "enabled" },
    ...overrides,
  } as unknown as StorageTargetDto;
}

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

describe("ImmutabilitySection", () => {
  it("names Object Lock with its mode and days, and offers to verify it", () => {
    const html = render(<ImmutabilitySection target={target({ immutability: immutability() })} />);
    expect(html).toContain("Immutable: Object Lock, compliance mode, 30 days");
    expect(html).toContain("not an administrator");
    expect(html).toContain("Verify now");
    expect(html).toContain("Change immutability");
  });

  it("warns when the verification found objects written without lock", () => {
    const html = render(
      <ImmutabilitySection
        target={target({
          immutability: immutability({
            verification: {
              checkedAt: "2026-10-10T00:00:00.000Z",
              sampled: 12,
              locked: 11,
              unlocked: 1,
              weakerMode: 0,
              missing: 0,
              errors: 0,
              problems: [],
            },
          }),
        })}
      />,
    );
    expect(html).toContain("Of 12 sampled objects, 1 was written without lock.");
  });

  it("calls a directory's deletion delay what it is, never immutable", () => {
    const html = render(
      <ImmutabilitySection
        target={target({
          kind: "local",
          objectLock: null,
          immutability: immutability({
            mode: "delayed_deletion",
            kind: "deletion_delay",
            days: 14,
          }),
        })}
      />,
    );
    expect(html).toContain("Deletion delay, 14 days (not immutable)");
    expect(html).toContain("can still delete the files");
    expect(html).not.toContain("Verify now");
  });

  it("says a bucket without Object Lock cannot hold immutable backups", () => {
    const html = render(
      <ImmutabilitySection target={target({ objectLock: { status: "disabled" } as never })} />,
    );
    expect(html).toContain("Immutable backups not available");
  });
});
