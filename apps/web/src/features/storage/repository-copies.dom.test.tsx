// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { type Rendered, render, slot } from "@/features/file-shares/testing";
import { json } from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "./i18n";
import {
  ObjectCopyStatus,
  type RepositoryCopy,
  TargetCopyLine,
  TargetCopySummary,
} from "./repository-copies";

/**
 * The copies of the restic repositories (docs/STORAGE.md, "restic repositories on copies"): per
 * copy target "x of y repositories current", per object "Copy on <target>: current / n behind /
 * failed (reason)".
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

const COPY: RepositoryCopy = {
  prefix: "endpoints/m-1/",
  kind: "machine",
  ownerId: "m-1",
  targetId: "target-2",
  targetName: "Offsite",
  state: "current",
  primarySnapshots: 4,
  missingSnapshots: 0,
  lastSnapshotId: "a1b2c3d4",
  lastCopiedAt: "2026-11-07T10:00:00.000Z",
  lastAttemptAt: "2026-11-07T10:00:00.000Z",
  lastError: null,
  lastCheckAt: "2026-11-07T10:00:00.000Z",
  lastCheckOk: true,
  lastDataCheckAt: null,
  deletionsDeferred: null,
  troubleSince: null,
};

describe("repository copies per copy target", () => {
  it("says how many repositories are current, and what is not", async () => {
    rendered = await render(
      <TargetCopySummary
        summary={{
          targetId: "target-2",
          targetName: "Offsite",
          total: 5,
          current: 2,
          behind: 1,
          failed: 1,
          pending: 1,
        }}
      />,
    );
    const line = slot("repository-copies-summary")?.textContent ?? "";
    expect(line).toContain("2 of 5 repositories current");
    expect(line).toContain("1 behind");
    expect(line).toContain("1 failed");
    expect(line).toContain("1 not copied yet");
  });

  it("reads the summary of its own target from the api, and shows nothing without repositories", async () => {
    rendered = await render(<TargetCopyLine targetId="target-2" />, {
      routes: {
        "GET /storage/repository-copies": () =>
          json({
            targets: [
              {
                targetId: "target-2",
                targetName: "Offsite",
                total: 3,
                current: 3,
                behind: 0,
                failed: 0,
                pending: 0,
              },
            ],
            repositories: [],
          }),
      },
    });
    await vi.waitFor(() => expect(slot("repository-copies-summary")).not.toBeNull());
    expect(slot("repository-copies-summary")?.textContent).toBe("3 of 3 repositories current");
    await rendered.mounted.unmount();
    document.body.innerHTML = "";
    rendered = await render(<TargetCopySummary summary={null} />);
    expect(slot("repository-copies-summary")).toBeNull();
  });
});

describe("repository copies on an object's page", () => {
  it("names each copy target with current, n behind or failed with the reason", async () => {
    rendered = await render(<ObjectCopyStatus ownerId="m-1" />, {
      routes: {
        "GET /storage/repository-copies/objects/m-1": () =>
          json({
            copies: [
              COPY,
              {
                ...COPY,
                targetId: "target-3",
                targetName: "NAS",
                state: "behind",
                missingSnapshots: 3,
              },
              {
                ...COPY,
                targetId: "target-4",
                targetName: "Bucket",
                state: "failed",
                lastError: "connection refused",
              },
              {
                ...COPY,
                targetId: "target-5",
                targetName: "Tape",
                state: "pending",
                deletionsDeferred: "write_once",
              },
            ],
          }),
      },
    });
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-slot="repository-copy"]').length).toBe(4),
    );
    const lines = [...document.querySelectorAll('[data-slot="repository-copy"]')].map(
      (node) => node.textContent,
    );
    expect(lines).toEqual([
      "Copy on Offsite: current",
      "Copy on NAS: 3 behind",
      "Copy on Bucket: failed (connection refused)",
      "Copy on Tape: not copied yet",
    ]);
    expect(slot("repository-copy-deferred")?.textContent).toContain("write-once");
  });

  it("shows nothing when the object has no copy", async () => {
    rendered = await render(<ObjectCopyStatus ownerId="vm-1" />, {
      routes: { "GET /storage/repository-copies/objects/vm-1": () => json({ copies: [] }) },
    });
    await vi.waitFor(() =>
      expect(rendered?.requests.some((r) => r.path.endsWith("/objects/vm-1"))).toBe(true),
    );
    expect(slot("repository-copies")).toBeNull();
  });
});
