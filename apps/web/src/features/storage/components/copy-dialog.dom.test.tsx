// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { action, type Rendered, render, slot, text } from "@/features/file-shares/testing";
import { click, flush, json } from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "../i18n";
import type { PromotionReadiness, StorageTargetDto } from "../types";
import { CopyDialog } from "./copy-dialog";

/**
 * "Make primary" (docs/STORAGE.md, "Promoting a copy"): the dialog shows every reason the server
 * gives before the click, each with what to do, offers "Catch up now" and follows its progress,
 * and enables the promotion only once the server says the copy is ready.
 */

let rendered: Rendered | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await rendered?.mounted.unmount();
  rendered = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const TARGET = {
  id: "target-2",
  name: "NAS",
  kind: "s3",
  role: "copy",
  status: "ok",
  canManage: true,
} as unknown as StorageTargetDto;

const COMPLETE = {
  complete: true,
  packs: { expected: 3, present: 3, bytesExpected: 300, bytesMissing: 0 },
  manifests: { expected: 2, present: 2 },
  keys: { expected: 1, present: 1 },
  archive: { expected: 0, present: 0 },
  missingSample: [],
  checkedAt: "2026-11-14T10:00:00.000Z",
};

function readiness(over: Partial<PromotionReadiness> = {}): PromotionReadiness {
  return {
    targetId: "target-2",
    ready: false,
    blockers: [],
    completeness: COMPLETE,
    currentPrimaryBecomes: "previous",
    repositories: { total: 2, current: 2, items: [], itemsOmitted: 0 },
    catchUp: { running: false, waiting: 0, scrub: null },
    canCatchUp: false,
    ...over,
  };
}

const BEHIND = readiness({
  blockers: [
    { code: "active_endpoints" },
    { code: "repository_copies_incomplete", repositories: 1 },
  ],
  repositories: {
    total: 2,
    current: 1,
    items: [
      {
        prefix: "pve-guests/g-1/",
        kind: "container",
        ownerId: "g-1",
        name: "paperless",
        readiness: "behind",
        missingSnapshots: 2,
        lastCopiedAt: null,
        lastAttemptAt: null,
        lastError: null,
      },
    ],
    itemsOmitted: 0,
  },
  canCatchUp: true,
});

function dialog() {
  return (
    <CopyDialog
      open
      onOpenChange={() => {}}
      target={TARGET}
      mode="promote"
      fromInstallationDefault={false}
    />
  );
}

describe("the promotion dialog", () => {
  it("lists every reason before the click, with what to do, and keeps the promotion disabled", async () => {
    rendered = await render(dialog(), {
      routes: {
        "POST /storage/targets/target-2/promotion/check": () => json(BEHIND),
        "GET /storage/targets/target-2/promotion": () => json(BEHIND),
      },
    });
    await vi.waitFor(() => expect(slot("promotion-blockers")).not.toBeNull());
    const blockers = [...document.querySelectorAll("[data-blocker]")].map((node) =>
      node.getAttribute("data-blocker"),
    );
    expect(blockers).toEqual(["active_endpoints", "repository_copies_incomplete"]);
    expect(text()).toContain("Machines back up to the primary");
    expect(text()).toContain("Revoke or uninstall those machines");
    expect(text()).toContain("1 backup repository is not complete on this copy");
    expect(slot("promotion-repository")?.textContent).toContain("Container paperless");
    expect(slot("promotion-repository")?.textContent).toContain("2 restore points missing");
    expect(text()).toContain("1 of 2 current on this copy");
    expect(action("promote")?.hasAttribute("disabled")).toBe(true);
    expect(action("catch-up")?.textContent).toContain("Catch up now");
    // Nothing was promoted.
    // The listings are compared on the operate-level check; nothing was promoted.
    expect(rendered.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /storage/targets/target-2/promotion/check",
    ]);
  });

  it("starts a catch-up, follows it, and enables the promotion once the server says ready", async () => {
    let state: PromotionReadiness = BEHIND;
    rendered = await render(dialog(), {
      routes: {
        "GET /storage/targets/target-2/promotion": () => json(state),
        "POST /storage/targets/target-2/promotion/check": () => json(state),
        "POST /storage/targets/target-2/catch-up": () => {
          state = readiness({
            ...BEHIND,
            blockers: [{ code: "repository_copies_incomplete", repositories: 1 }],
            catchUp: {
              running: true,
              waiting: 1,
              scrub: {
                jobId: "job-1",
                status: "active",
                createdAt: "2026-11-14T10:00:00.000Z",
                finishedAt: null,
              },
            },
          });
          return json(state, 202);
        },
        "POST /storage/targets/target-2/promote": () =>
          json({ target: { ...TARGET, role: "primary" }, previousPrimaryId: "target-1" }),
        "GET /storage/targets": () => json({ items: [] }),
      },
    });
    await vi.waitFor(() => expect(action("catch-up")).not.toBeNull());
    await click(action("catch-up"));
    await vi.waitFor(() => expect(slot("catch-up-progress")).not.toBeNull());
    expect(slot("catch-up-progress")?.textContent).toContain("Storage check running");
    expect(slot("catch-up-progress")?.textContent).toContain(
      "1 backup repository waits for the copy",
    );
    expect(action("promote")?.hasAttribute("disabled")).toBe(true);

    // The copies are made; the next answer says ready.
    state = readiness({ ready: true });
    await vi.waitFor(() => expect(document.querySelector('[data-ready="true"]')).not.toBeNull(), {
      timeout: 8_000,
    });
    expect(action("promote")?.hasAttribute("disabled")).toBe(false);
    await click(action("promote"));
    await flush();
    expect(
      rendered.requests.some(
        (request) =>
          request.method === "POST" && request.path === "/storage/targets/target-2/promote",
      ),
    ).toBe(true);
  }, 15_000);
});
