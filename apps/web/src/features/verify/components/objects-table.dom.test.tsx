// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ObjectReadiness } from "@/features/verify/api";
import { useVerifyFormat } from "@/features/verify/use-verify";
import { i18n } from "@/i18n";

import "../i18n.js";
import { ObjectsTable } from "./objects-table";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
      <a href={String(to)}>{children}</a>
    ),
  };
});

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage("en");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function emptyObject(id: string, name: string): ObjectReadiness {
  return {
    object: {
      id,
      kind: "onedrive",
      displayName: name,
      externalId: `${id}-drive`,
      status: "active",
      email: null,
      upn: null,
    },
    state: "yellow",
    readiness: "yellow",
    checkedAt: "2026-09-20T03:00:00.000Z",
    overdue: false,
    latestSnapshotAt: "2026-09-20T02:00:00.000Z",
    report: {
      id: `r-${id}`,
      kind: "verify",
      origin: "verify",
      reasons: [
        { code: "snapshot_empty", severity: "yellow", count: 4, ageHours: null, failure: null },
      ],
      counts: { checked: 0, verified: 0, failed: 0 },
    },
    running: null,
    latestSnapshotId: `s-${id}`,
    previousCheck: null,
    contentStats: { items: 4, bytes: 0 },
    emptyConfirmation: null,
  };
}

function Table({ ask }: { ask: (ids: string[]) => void }) {
  const format = useVerifyFormat();
  return (
    <ObjectsTable
      items={[emptyObject("a", "Drive A"), emptyObject("b", "Drive B")]}
      format={format}
      startingObjectId={null}
      nextBackupAt={null}
      onCheck={() => {}}
      state="empty_unconfirmed"
      onStateChange={() => {}}
      empty={{ ask, revoke: () => {}, revoking: null }}
    />
  );
}

describe("ObjectsTable: confirming empty objects together", () => {
  it("selects all empty ones and hands exactly them to the confirmation", () => {
    const ask = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        <I18nextProvider i18n={i18n}>
          <Table ask={ask} />
        </I18nextProvider>,
      ),
    );
    const bar = host.querySelector('[data-slot="empty-selection"]') as HTMLElement;
    const confirm = [...bar.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("as empty"),
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const all = bar.querySelector('[role="checkbox"]') as HTMLElement;
    act(() => all.click());
    expect(bar.textContent).toContain("2 of 2 selected");
    expect(confirm.disabled).toBe(false);
    act(() => confirm.click());
    expect(ask).toHaveBeenCalledWith(["a", "b"]);

    // One row off: only the other one goes.
    const rowBox = host.querySelector('[aria-label="Select Drive A"]') as HTMLElement;
    act(() => rowBox.click());
    act(() => confirm.click());
    expect(ask).toHaveBeenLastCalledWith(["b"]);
  });
});
