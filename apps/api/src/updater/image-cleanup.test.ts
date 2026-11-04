import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatBytes,
  installationRepositories,
  planImageCleanup,
  referenceMatches,
  repositoryOf,
} from "./image-cleanup.js";
import { type LocalImage, OpsError } from "./ops.js";
import {
  apiAt,
  createHarness,
  digestOf,
  type Harness,
  scheduleRequest,
  settle,
} from "./testing.js";

const MB = 1000 ** 2;
const APP = "ghcr.io/restow-backup/restow";
const WEB = "ghcr.io/restow-backup/restow-web";

function image(
  seed: string,
  refs: { tags?: string[]; digests?: string[] },
  version: string | null,
  bytes = 100 * MB,
): LocalImage {
  return {
    id: digestOf(seed),
    tags: refs.tags ?? [],
    digests: refs.digests ?? [],
    bytes,
    version,
  };
}

const repositories = installationRepositories({
  imageRepository: APP,
  webImageRepository: WEB,
  references: [],
});

describe("references and repositories", () => {
  it("takes the repository out of tags, digests and Docker Hub names", () => {
    expect(repositoryOf(`${APP}:0.1.0`)).toBe(APP);
    expect(repositoryOf(`${APP}@sha256:${"a".repeat(64)}`)).toBe(APP);
    expect(repositoryOf(`${APP}:0.1.0@sha256:${"a".repeat(64)}`)).toBe(APP);
    expect(repositoryOf("registry.example.com:5000/acme/restow:1")).toBe(
      "registry.example.com:5000/acme/restow",
    );
    expect(repositoryOf("docker.io/library/restow:local")).toBe("restow");
  });

  it("knows both builds' repositories and the local source-mode names, nothing else", () => {
    expect([...repositories].sort()).toEqual(
      [
        APP,
        WEB,
        `${APP}-community`,
        `${WEB}-community`,
        "restow",
        "restow-web",
        "restow-community",
        "restow-web-community",
      ].sort(),
    );
    const community = installationRepositories({
      imageRepository: "registry.example.com/acme/restow-community",
      webImageRepository: "registry.example.com/acme/restow-web-community",
      references: [`registry.example.com/acme/updater@sha256:${"b".repeat(64)}`, null],
    });
    expect(community.has("registry.example.com/acme/restow")).toBe(true);
    expect(community.has("registry.example.com/acme/restow-web")).toBe(true);
    expect(community.has("registry.example.com/acme/updater")).toBe(true);
    expect(community.has("postgres")).toBe(false);
  });

  it("matches a reference by tag, by digest or by ID", () => {
    const pulled = image(
      "x",
      { tags: [`${APP}:0.1.0`], digests: [`${APP}@${digestOf("d")}`] },
      null,
    );
    expect(referenceMatches(`${APP}:0.1.0`, pulled)).toBe(true);
    expect(referenceMatches(`${APP}:0.2.0`, pulled)).toBe(false);
    expect(referenceMatches(`${APP}@${digestOf("d")}`, pulled)).toBe(true);
    expect(referenceMatches(`${APP}:0.1.0@${digestOf("d")}`, pulled)).toBe(true);
    expect(referenceMatches(`${WEB}@${digestOf("d")}`, pulled)).toBe(false);
    expect(referenceMatches(digestOf("x"), pulled)).toBe(true);
    expect(referenceMatches(APP, pulled)).toBe(false);
    expect(referenceMatches(APP, image("y", { tags: [`${APP}:latest`] }, null))).toBe(true);
  });

  it("formats sizes for the log", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(340 * MB)).toBe("340 MB");
    expect(formatBytes(12_800 * MB)).toBe("13 GB");
    expect(formatBytes(1_250 * MB)).toBe("1.3 GB");
  });
});

describe("planImageCleanup", () => {
  const images = [
    image("current", { tags: [`${APP}:0.5.0`] }, "0.5.0"),
    image("current-web", { tags: [`${WEB}:0.5.0`] }, "0.5.0"),
    image("previous", { tags: [`${APP}:0.4.12`] }, "0.4.12"),
    image("previous-web", { tags: [`${WEB}:0.4.12`] }, "0.4.12"),
    image("old", { tags: [`${APP}:0.4.11`] }, "0.4.11", 900 * MB),
    image("old-web", { tags: [`${WEB}:0.4.11`] }, "0.4.11", 80 * MB),
    // Pulled by digest (an earlier updater image): no tag, the label says the version.
    image("old-pinned", { digests: [`${APP}@${digestOf("pinned")}`] }, "0.4.2"),
    image("old-community", { tags: [`${APP}-community:0.3.0`] }, "0.3.0"),
    // A version tag and no label (an image built before the label existed).
    image("old-tag-only", { tags: [`${APP}:0.2.0`] }, null),
    image("local", { tags: ["restow:local"] }, null),
    image("newer", { tags: [`${APP}:0.6.0-rc.1`] }, "0.6.0-rc.1"),
    image("in-use", { tags: [`${APP}:0.4.0`] }, "0.4.0"),
    image("configured", { tags: [`${APP}:0.4.1`] }, "0.4.1"),
    image("foreign", { tags: ["postgres:16-alpine"] }, "16"),
    image("shared", { tags: [`${APP}:0.1.0`, "acme/backup:old"] }, "0.1.0"),
    image("dangling", {}, "0.1.0"),
  ];

  function plan(over: Partial<Parameters<typeof planImageCleanup>[0]> = {}) {
    return planImageCleanup({
      images,
      inUse: new Set([digestOf("in-use"), digestOf("current"), digestOf("current-web")]),
      repositories,
      keep: [`${APP}:0.4.1`, null],
      currentVersion: "0.5.0",
      previousVersion: "0.4.12",
      ...over,
    });
  }

  it("removes only own images of releases older than the previous one", () => {
    const result = plan();
    expect(result.cutoff).toBe("0.4.12");
    expect(result.remove.map((entry) => entry.id).sort()).toEqual(
      [
        digestOf("old"),
        digestOf("old-web"),
        digestOf("old-pinned"),
        digestOf("old-community"),
        digestOf("old-tag-only"),
      ].sort(),
    );
    const reasons = Object.fromEntries(result.kept.map((entry) => [entry.image.id, entry.reason]));
    expect(reasons).toEqual({
      [digestOf("current")]: "in_use",
      [digestOf("current-web")]: "in_use",
      [digestOf("previous")]: "current_or_previous",
      [digestOf("previous-web")]: "current_or_previous",
      [digestOf("local")]: "unknown_version",
      [digestOf("newer")]: "current_or_previous",
      [digestOf("in-use")]: "in_use",
      [digestOf("configured")]: "configured",
    });
    // Never looked at: someone else's image, one shared with another repository, a dangling one.
    for (const seed of ["foreign", "shared", "dangling"]) {
      expect(result.kept.some((entry) => entry.image.id === digestOf(seed))).toBe(false);
      expect(result.remove.some((entry) => entry.id === digestOf(seed))).toBe(false);
    }
  });

  it("takes the newest older release present as the previous one when it is not known", () => {
    const result = plan({ previousVersion: null });
    expect(result.cutoff).toBe("0.4.12");
    expect(result.remove).toHaveLength(5);
  });

  it("removes nothing when the current version is not a version", () => {
    const result = plan({ currentVersion: "local" });
    expect(result.cutoff).toBeNull();
    expect(result.remove).toEqual([]);
  });

  it("after a build switch keeps the other build of the same version", () => {
    const switched = planImageCleanup({
      images: [
        image("full", { tags: [`${APP}:0.5.0`] }, "0.5.0"),
        image("community", { tags: [`${APP}-community:0.5.0`] }, "0.5.0"),
        image("community-old", { tags: [`${APP}-community:0.4.12`] }, "0.4.12"),
      ],
      inUse: new Set([digestOf("full")]),
      repositories: installationRepositories({
        imageRepository: `${APP}-community`,
        webImageRepository: `${WEB}-community`,
        references: [],
      }),
      keep: [],
      currentVersion: "0.5.0",
      previousVersion: "0.5.0",
    });
    expect(switched.remove.map((entry) => entry.id)).toEqual([digestOf("community-old")]);
  });
});

// ---------------------------------------------------------------------------
// In the engine
// ---------------------------------------------------------------------------

const NEW_APP = `${APP}:0.2.0`;
const NEW_WEB = `${WEB}:0.2.0`;

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  apiAt(h, NEW_APP, { kind: "ready", migrates: 1, reportsVersion: "0.2.0" });
  h.ops.imageStore.push(
    image("new", { tags: [NEW_APP] }, "0.2.0", 700 * MB),
    image("new-web", { tags: [NEW_WEB] }, "0.2.0", 60 * MB),
    image("previous", { tags: [`${APP}:0.1.0`] }, "0.1.0", 690 * MB),
    image("previous-web", { tags: [`${WEB}:0.1.0`] }, "0.1.0", 60 * MB),
    image("old", { tags: [`${APP}:0.0.9`] }, "0.0.9", 650 * MB),
    image("old-web", { tags: [`${WEB}:0.0.9`] }, "0.0.9", 50 * MB),
    image("old-updater", { digests: [`${APP}@${digestOf("u")}`] }, "0.0.5", 600 * MB),
    image("old-stopped", { tags: [`${APP}:0.0.8`] }, "0.0.8", 640 * MB),
    image("foreign", { tags: ["postgres:16-alpine"] }, null, 270 * MB),
    image("foreign-old", { tags: ["acme/tool:0.0.1"] }, "0.0.1", 10 * MB),
  );
  // A stopped container (not of the project) still uses 0.0.8.
  h.ops.otherContainerImages.add(digestOf("old-stopped"));
});

afterEach(async () => {
  await h.cleanup();
});

async function update(version = "0.2.0") {
  await h.engine.schedule(scheduleRequest(version));
  await settle(h.engine);
  return h.engine.view();
}

function remaining(): string[] {
  return h.ops.imageStore.map((entry) => entry.tags[0] ?? entry.digests[0] ?? entry.id);
}

describe("old images after an update", () => {
  it("removes the images of earlier releases once the run succeeded, by ID", async () => {
    const view = await update();
    expect(view.phase).toBe("succeeded");
    expect(view.run?.outcome).toBe("succeeded");
    expect(view.run?.message).toEqual({ code: "run.succeeded", params: { version: "0.2.0" } });

    expect(h.ops.callsTo("removeImage").sort()).toEqual(
      [
        `removeImage ${digestOf("old")}`,
        `removeImage ${digestOf("old-web")}`,
        `removeImage ${digestOf("old-updater")}`,
      ].sort(),
    );
    expect(remaining()).toEqual([
      NEW_APP,
      NEW_WEB,
      `${APP}:0.1.0`,
      `${WEB}:0.1.0`,
      `${APP}:0.0.8`,
      "postgres:16-alpine",
      "acme/tool:0.0.1",
    ]);

    // Only after the run was recorded as succeeded: the last step had finished.
    const calls = h.ops.calls;
    const lastUp = calls.lastIndexOf("composeUp caddy");
    expect(calls.indexOf("listImages")).toBeGreaterThan(lastUp);

    const finish = view.run?.steps.find((step) => step.id === "finish");
    expect(finish?.detail).toMatchObject({
      oldImagesRemoved: 3,
      oldImagesBytes: 1300 * MB,
      oldImagesFailed: 0,
    });
    expect(
      view.run?.log.some((line) => line.includes("Removed 3 images of earlier releases (1.3 GB)")),
    ).toBe(true);
    // The history entry carries it too.
    expect(view.history[0]?.steps.find((step) => step.id === "finish")?.detail).toMatchObject({
      oldImagesRemoved: 3,
    });
  });

  it("keeps whatever is configured: the pinned updater and mounter images stay", async () => {
    h.ops.updaterImage = "pinned"; // ghcr.io/restow-backup/restow:0.1.0 in the fake
    h.ops.imageStore.push(image("mounter-pin", { digests: [`${APP}@${digestOf("m")}`] }, "0.0.4"));
    await fs.appendFile(
      path.join(h.projectDir, ".env"),
      `RESTOW_MOUNTER_IMAGE=${APP}@${digestOf("m")}\n`,
    );
    await update();
    expect(h.ops.callsTo("removeImage")).not.toContain(`removeImage ${digestOf("mounter-pin")}`);
    expect(remaining()).toContain(`${APP}@${digestOf("m")}`);
  });

  it("logs a refused removal and stays succeeded", async () => {
    h.ops.failOn(
      "removeImage",
      new OpsError(
        "Removing the image failed (exit code 1).",
        "conflict: image has dependent child images",
      ),
      0,
    );
    const view = await update();
    expect(view.phase).toBe("succeeded");
    expect(view.run?.outcome).toBe("succeeded");
    expect(h.ops.callsTo("removeImage")).toHaveLength(3);
    expect(view.run?.steps.find((step) => step.id === "finish")?.detail).toMatchObject({
      oldImagesRemoved: 2,
      oldImagesFailed: 1,
    });
    expect(
      h.logger.lines.some((line) => line.startsWith("WARN Could not remove the old image")),
    ).toBe(true);
    expect(view.run?.log.at(-1)).toContain("1 could not be removed");
  });

  it("removes nothing when the images cannot be listed, and stays succeeded", async () => {
    h.ops.failOn("listImages", new OpsError("Listing the images failed (exit code 1)."));
    const view = await update();
    expect(view.phase).toBe("succeeded");
    expect(h.ops.callsTo("removeImage")).toEqual([]);
    expect(view.run?.log.at(-1)).toContain("could not be removed: Listing the images failed");
  });

  it("removes nothing when the containers cannot be listed", async () => {
    h.ops.failOn("containerImageIds", new OpsError("Listing the containers failed (exit code 1)."));
    expect((await update()).phase).toBe("succeeded");
    expect(h.ops.callsTo("removeImage")).toEqual([]);
  });

  it("never touches an image when the run failed, was rolled back or needs attention", async () => {
    // unchanged: the pull fails.
    h.ops.registry.set(NEW_APP, "not_found");
    let view = await update();
    expect(view.run?.outcome).toBe("unchanged");
    expect(h.ops.callsTo("listImages")).toEqual([]);
    await h.engine.acknowledge();

    // rolled_back: the new api never answers and did not migrate.
    h.ops.registry.delete(NEW_APP);
    apiAt(h, NEW_APP, { kind: "never" });
    view = await update();
    expect(view.run?.outcome).toBe("rolled_back");
    await h.engine.acknowledge();

    // needs_attention: the new api migrated and then never answered.
    apiAt(h, NEW_APP, { kind: "never", migrates: 1 });
    view = await update();
    expect(view.run?.outcome).toBe("needs_attention");

    expect(h.ops.callsTo("listImages")).toEqual([]);
    expect(h.ops.callsTo("removeImage")).toEqual([]);
    expect(h.ops.imageStore).toHaveLength(10);
  });
});
