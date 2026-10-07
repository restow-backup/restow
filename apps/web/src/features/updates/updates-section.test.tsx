// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { formatDateTime } from "@/lib/format";

import {
  CHECK_ERROR_CODES,
  type CheckError,
  type CheckErrorCode,
  type UpdatesView,
  idleMaintenance,
} from "./api";
import { updatesRefetchInterval } from "./hooks";
import {
  type Mounted,
  NOW,
  blur,
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  iso,
  json,
  maintenanceFixture,
  mount,
  problem,
  releaseFixture,
  routedFetch,
  runFixture,
  sessionAs,
  type as typeInto,
  updatesFixture,
} from "./testing";
import { UpdatesContent, UpdatesSection } from "./updates-section";

/**
 * The Updates tab, rendered into a DOM: every state the api can put it in,
 * the forms and dialogs, and what a lower provider role or the demo may not do.
 */

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function show(view: UpdatesView, options: { canManage?: boolean } = {}): HTMLElement {
  mounted = mount(
    <UpdatesContent view={view} receivedAt={NOW} canManage={options.canManage ?? true} />,
  );
  return mounted.container;
}

function text(scope: ParentNode = document.body): string {
  return (scope.textContent ?? "").replace(/\s+/g, " ").trim();
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="alertdialog"]');
}

function slot(name: string, scope: ParentNode = document.body): HTMLElement | null {
  return scope.querySelector<HTMLElement>(`[data-slot="${name}"]`);
}

describe("updatesRefetchInterval", () => {
  it("follows an announced or running maintenance closely and otherwise rests", () => {
    const scheduled = updatesFixture({
      maintenance: maintenanceFixture({ phase: "scheduled" }),
    });
    const running = updatesFixture({ maintenance: maintenanceFixture({ phase: "running" }) });
    expect(updatesRefetchInterval(scheduled)).toBe(3000);
    expect(updatesRefetchInterval(running)).toBe(3000);
    for (const phase of ["idle", "succeeded", "failed"] as const) {
      expect(
        updatesRefetchInterval(updatesFixture({ maintenance: maintenanceFixture({ phase }) })),
      ).toBe(false);
    }
    expect(updatesRefetchInterval(undefined)).toBe(false);
  });
});

describe("loading and failing", () => {
  it("shows a skeleton while the first answer is on its way", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    mounted = mount(<UpdatesSection />);
    await flush();
    expect(slot("updates-loading")).not.toBeNull();
    expect(text()).not.toContain("Version");
  });

  it("says what failed and retries on request", async () => {
    const view = updatesFixture();
    let attempts = 0;
    const { mock } = routedFetch({
      "GET /updates": () => {
        attempts += 1;
        return attempts === 1 ? problem("about:blank", 500) : json(view);
      },
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    expect(text()).toContain("Update information could not be loaded");
    const retry = buttonByText(document.body, "Retry");
    expect(retry).not.toBeNull();

    await click(retry);
    await flush(5);
    expect(attempts).toBe(2);
    expect(text()).toContain("Running version");
    expect(text()).not.toContain("Update information could not be loaded");
  });
});

describe("the version card", () => {
  it("says the check is off, and Check now cannot be used", () => {
    const root = show(
      updatesFixture({
        settings: { enabled: false, channel: "stable", sourceUrl: null, tokenSet: false },
        check: {
          enabled: false,
          state: "disabled",
          checkedAt: null,
          nextCheckAt: null,
          error: null,
        },
        latest: null,
        updateAvailable: null,
        releases: [],
      }),
    );
    expect(text(slot("check-status", root) as HTMLElement)).toContain("Update check is off");
    expect(text(root)).toContain("Turn it on in the source settings below to check now");
    expect(buttonByText(root, "Check now")?.disabled).toBe(true);
    expect(text(slot("releases-empty", root) as HTMLElement)).toContain("the update check is off");
    expect(text(slot("check-status", root) as HTMLElement)).not.toContain("Up to date");
  });

  it("says nothing was checked yet", () => {
    const root = show(
      updatesFixture({
        check: { enabled: true, state: "pending", checkedAt: null, nextCheckAt: null, error: null },
        latest: null,
        updateAvailable: null,
        releases: [],
      }),
    );
    expect(text(slot("check-status", root) as HTMLElement)).toContain("Not checked yet");
    expect(text(root)).toContain("Never");
    expect(buttonByText(root, "Check now")?.disabled).toBe(false);
    expect(text(slot("releases-empty", root) as HTMLElement)).toContain("the check has not run");
  });

  it("says up to date, and shows the latest release as installed", () => {
    const latest = releaseFixture({ version: "0.1.0", tag: "v0.1.0" });
    const root = show(updatesFixture({ latest, updateAvailable: false, releases: [] }));
    const status = slot("check-status", root) as HTMLElement;
    expect(status.dataset.kind).toBe("upToDate");
    expect(text(status)).toContain("Up to date");
    expect(text(status)).toContain("newest release in the Stable channel");
    expect(text(root)).toContain("Latest release");
    expect(text(slot("release", root) as HTMLElement)).toContain("Installed");
  });

  it("says an update is available, with the tag and the release date", () => {
    const root = show(updatesFixture());
    const status = slot("check-status", root) as HTMLElement;
    expect(status.dataset.kind).toBe("available");
    expect(text(status)).toContain("Update available: 0.2.0");
    expect(text(status)).toContain("Tag v0.2.0, released Sep 28, 2026");
    expect(text(slot("running-version", root) as HTMLElement)).toBe("0.1.0");
  });

  it("compares nothing when the build reports no version", () => {
    const root = show(updatesFixture({ running: null, updateAvailable: null, releases: [] }));
    expect(text(slot("check-status", root) as HTMLElement)).toContain("Latest release: 0.2.0");
    expect(text(root)).toContain("carries no release version");
  });

  it("keeps the last good result next to a failed check", () => {
    const error: CheckError = { code: "network", status: null, retryAt: null, detail: null };
    const root = show(
      updatesFixture({
        check: { enabled: true, state: "failed", checkedAt: iso(-100), nextCheckAt: null, error },
      }),
    );
    const status = slot("check-status", root) as HTMLElement;
    expect(text(status)).toContain("Last check failed");
    expect(text(status)).toContain("The source could not be reached");
    expect(text(slot("last-known", root) as HTMLElement)).toContain(
      "Last successful check: version 0.2.0 (tag v0.2.0) is available.",
    );
    // The release list stays visible too.
    expect(text(root)).toContain("Available releases");
  });

  const REASONS: Record<CheckErrorCode, string> = {
    rate_limited: "limiting requests",
    unauthorized: "rejected the access token",
    not_found: "repository was not found, or it is private",
    forbidden: "refused access",
    server_error: "reported a server error",
    network: "could not be reached",
    timeout: "did not answer in time",
    invalid_response: "not a release list",
    no_release: "no release for this channel",
    redirect: "redirected the request",
  };

  it("has a reason for every failure code the api knows", async () => {
    expect(Object.keys(REASONS).sort()).toEqual([...CHECK_ERROR_CODES].sort());
    for (const code of CHECK_ERROR_CODES) {
      const error: CheckError = {
        code,
        status: code === "not_found" ? 404 : null,
        retryAt: null,
        detail: null,
      };
      const root = show(
        updatesFixture({
          latest: null,
          updateAvailable: null,
          releases: [],
          check: { enabled: true, state: "failed", checkedAt: iso(-100), nextCheckAt: null, error },
        }),
      );
      const status = slot("check-status", root) as HTMLElement;
      expect(text(status), code).toContain("Last check failed");
      expect(text(status), code).toContain(REASONS[code]);
      expect(text(status), code).not.toContain("check.errors");
      await mounted?.unmount();
      mounted = null;
    }
  });

  it("names the time a rate limit is lifted, and shows the technical hint", () => {
    const retryAt = iso(1800);
    const error: CheckError = {
      code: "rate_limited",
      status: 403,
      retryAt,
      detail: "API rate limit exceeded",
    };
    const root = show(
      updatesFixture({
        check: { enabled: true, state: "failed", checkedAt: iso(-100), nextCheckAt: null, error },
      }),
    );
    const failure = slot("check-error", root) as HTMLElement;
    expect(text(failure)).toContain(
      `Requests are allowed again at ${formatDateTime(retryAt, "en")}`,
    );
    expect(text(failure)).toContain("HTTP status 403 | API rate limit exceeded");
  });

  it("runs the check on request and shows the answer", async () => {
    const before = updatesFixture({
      check: { enabled: true, state: "pending", checkedAt: null, nextCheckAt: null, error: null },
      latest: null,
      updateAvailable: null,
      releases: [],
    });
    const after = updatesFixture();
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(before),
      "POST /updates/check": () => json(after),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    await click(buttonByText(document.body, "Check now"));
    await flush(5);
    expect(
      requests.some((request) => request.method === "POST" && request.path === "/updates/check"),
    ).toBe(true);
    expect(text(slot("check-status") as HTMLElement)).toContain("Update available: 0.2.0");
  });
});

describe("release notes", () => {
  it("collapses the notes and renders them as safe Markdown when opened", async () => {
    const release = releaseFixture({
      notes:
        "## Highlights\n\n- Faster **restores**\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))",
    });
    const root = show(updatesFixture({ latest: release, releases: [release] }));

    expect(text(root)).not.toContain("Highlights");
    await click(buttonByText(root, "Show release notes"));
    const notes = slot("markdown", root) as HTMLElement;
    expect(notes).not.toBeNull();
    expect(text(notes)).toContain("Highlights");
    expect(notes.querySelector("strong")?.textContent).toBe("restores");
    expect(notes.querySelector("script")).toBeNull();
    expect(notes.querySelector("a")).toBeNull();
    expect(text(notes)).toContain("<script>alert(1)</script>");
    expect(notes.querySelector("h5")).not.toBeNull();

    await click(buttonByText(root, "Hide release notes"));
    expect(slot("markdown", root)).toBeNull();
  });

  it("links to the release page in a new tab and marks pre-releases", () => {
    const release = releaseFixture({ prerelease: true, version: "0.3.0-rc.1", tag: "v0.3.0-rc.1" });
    const root = show(updatesFixture({ latest: release, releases: [release] }));
    const link = root.querySelector<HTMLAnchorElement>('a[href^="https://github.com"]');
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
    expect(text(slot("release", root) as HTMLElement)).toContain("Pre-release");
    expect(text(slot("release", root) as HTMLElement)).toContain("v0.3.0-rc.1");
  });

  it("does not link to a release page that is not a web address", () => {
    const release = releaseFixture({ url: "javascript:alert(1)" });
    const root = show(updatesFixture({ latest: release, releases: [release] }));
    expect(root.querySelector('a[href^="javascript"]')).toBeNull();
    expect(text(slot("release", root) as HTMLElement)).not.toContain("Release page");
  });

  it("says when the notes are cut, and when there are none", async () => {
    const cut = releaseFixture({ notes: "Some notes", notesTruncated: true });
    const empty = releaseFixture({ version: "0.2.1", tag: "v0.2.1", notes: null });
    const root = show(updatesFixture({ latest: cut, releases: [cut, empty] }));
    await click(buttonByText(root, "Show release notes"));
    expect(text(slot("notes-truncated", root) as HTMLElement)).toContain(
      "The full text is on the release page",
    );
    expect(text(root)).toContain("This release has no notes.");
  });
});

describe("the source form", () => {
  it("sends only what changed", async () => {
    const view = updatesFixture();
    const saved = updatesFixture({
      settings: {
        enabled: false,
        channel: "beta",
        sourceUrl: "https://git.example.test/team/restow",
        tokenSet: false,
      },
      mode: "source",
    });
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(view),
      "PATCH /updates/settings": () => json(saved),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    const save = () => buttonByText(document.body, "Save");
    expect(save()?.disabled).toBe(true);
    expect(text()).toContain("All changes are saved.");

    await click(document.body.querySelector('input[name="updates-channel"][value="beta"]'));
    expect(text()).toContain("You have unsaved changes.");
    await click(document.getElementById("updates-check-enabled"));
    await typeInto(
      document.body.querySelector("#updates-source-url"),
      "https://git.example.test/team/restow",
    );
    expect(save()?.disabled).toBe(false);

    await click(save());
    await flush(5);
    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.body).toEqual({
      enabled: false,
      channel: "beta",
      sourceUrl: "https://git.example.test/team/restow",
    });
    // The stored state comes back: the form is clean again.
    expect(text()).toContain("All changes are saved.");
    expect(slot("update-mode")?.dataset.mode).toBe("source");
  });

  it("asks to confirm it is you when the source change needs a recent sign-in", async () => {
    const view = updatesFixture();
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(view),
      "PATCH /updates/settings": () =>
        problem("urn:restow:problem:recent-sign-in-required", 403, { maxAgeSeconds: 600 }),
      "GET /setup/state": () =>
        json({ passkeyReady: { ready: false, reasons: [], rpId: null, origin: null } }),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);
    await typeInto(
      document.body.querySelector("#updates-source-url"),
      "https://git.example.test/team/restow",
    );
    await click(buttonByText(document.body, "Save"));
    await flush(5);
    expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
    expect(text()).toContain("Confirm it is you first");
    const confirm = slot("confirm-identity") as HTMLElement;
    expect(text(confirm)).toContain("needs a sign-in from the last 10 minutes");
    expect(buttonByText(confirm, "Sign in again")).not.toBeNull();
    // What was typed stays; nothing was saved.
    expect(text()).toContain("You have unsaved changes.");
  });

  it("shows the default source as a placeholder and resets to it", async () => {
    const view = updatesFixture({
      settings: {
        enabled: true,
        channel: "stable",
        sourceUrl: "https://git.example.test/team/restow",
        tokenSet: false,
      },
      source: {
        origin: "settings",
        url: "https://git.example.test/team/restow",
        provider: "forgejo",
        repository: "team/restow",
        isDefault: false,
        isAlpha: false,
      },
      mode: "source",
    });
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(view),
      "PATCH /updates/settings": () => json(updatesFixture()),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    const url = document.body.querySelector<HTMLInputElement>("#updates-source-url");
    expect(url?.value).toBe("https://git.example.test/team/restow");
    expect(url?.placeholder).toBe("Default: https://github.com/restow-backup/restow");
    expect(text(slot("update-mode") as HTMLElement)).toContain("Build from source");

    await click(buttonByText(document.body, "Use default"));
    expect(url?.value).toBe("");
    await click(buttonByText(document.body, "Save"));
    await flush(5);
    expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({
      sourceUrl: null,
    });
  });

  it("offers the alpha channel with a warning, and warns when the updater skips signatures", async () => {
    const base = updatesFixture();
    const view = updatesFixture({
      updater: { ...base.updater, signatureChecks: false },
    });
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(view),
      "PATCH /updates/settings": () => json(updatesFixture()),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    expect(text(slot("signatures-off") as HTMLElement)).toContain("does not verify signatures");
    expect(slot("alpha-warning")).toBeNull();

    await click(buttonByText(document.body, "Use the alpha channel"));
    const warning = slot("alpha-warning") as HTMLElement;
    expect(text(warning)).toContain("unsigned test builds");
    await click(buttonByText(document.body, "Save"));
    await flush(5);
    expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({
      sourceUrl: "https://github.com/restow-backup/restow-alpha",
      channel: "beta",
    });
  });

  it("refuses an address that is not a web address", async () => {
    const { mock, requests } = routedFetch({ "GET /updates": () => json(updatesFixture()) });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    const url = document.body.querySelector("#updates-source-url");
    await typeInto(url, "ftp://example.test/repo");
    await blur(url);
    expect(text()).toContain("The address must start with https:// or http://.");
    expect(buttonByText(document.body, "Save")?.disabled).toBe(true);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);

    await typeInto(url, "not a url");
    expect(text()).toContain("Enter a full web address");
  });

  it("shows the image update mode with its explanation", () => {
    const root = show(updatesFixture());
    const mode = slot("update-mode", root) as HTMLElement;
    expect(mode.dataset.mode).toBe("image");
    expect(text(mode)).toContain("Image update");
    expect(text(mode)).toContain("Downloads the published release image");
  });

  it("discards edits", async () => {
    const root = show(updatesFixture());
    await click(root.querySelector('input[name="updates-channel"][value="beta"]'));
    expect(text(root)).toContain("You have unsaved changes.");
    await click(buttonByText(root, "Discard changes"));
    expect(text(root)).toContain("All changes are saved.");
    expect(
      (root.querySelector('input[name="updates-channel"][value="stable"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("explains the environment override, shows its address and locks what it wins over", async () => {
    const view = updatesFixture({
      environmentOverride: { url: "https://mirror.example.test/restow/releases.atom" },
      source: {
        origin: "environment",
        url: "https://mirror.example.test/restow/releases.atom",
        provider: "feed",
        repository: null,
        isDefault: false,
        isAlpha: false,
      },
    });
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(view),
      "PATCH /updates/settings": () => json(view),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    const note = slot("environment-override") as HTMLElement;
    expect(text(note)).toContain("RESTOW_UPDATE_CHECK_URL");
    expect(text(note)).toContain("wins over");
    expect(text(slot("environment-url") as HTMLElement)).toBe(
      "https://mirror.example.test/restow/releases.atom",
    );

    const url = document.body.querySelector<HTMLInputElement>("#updates-source-url");
    expect(url?.readOnly).toBe(true);
    expect(url?.value).toBe("https://mirror.example.test/restow/releases.atom");
    expect(
      (document.body.querySelector("#updates-check-enabled") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((document.body.querySelector("#updates-token") as HTMLInputElement).disabled).toBe(true);
    // The channel still can be changed, and only it is sent.
    const beta = document.body.querySelector<HTMLInputElement>(
      'input[name="updates-channel"][value="beta"]',
    );
    expect(beta?.disabled).toBe(false);
    await click(beta);
    await click(buttonByText(document.body, "Save"));
    await flush(5);
    expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({
      channel: "beta",
    });
  });
});

describe("the access token", () => {
  const SECRET = "ghp_supersecret_value_123";

  it("takes a token in a password field that is never autofilled", async () => {
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(updatesFixture()),
      "PATCH /updates/settings": () =>
        json(
          updatesFixture({
            settings: { enabled: true, channel: "stable", sourceUrl: null, tokenSet: true },
          }),
        ),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    const input = document.body.querySelector<HTMLInputElement>("#updates-token");
    expect(input?.type).toBe("password");
    expect(input?.autocomplete).toBe("off");
    expect(text()).not.toContain("A token is stored.");

    await typeInto(input, SECRET);
    await click(buttonByText(document.body, "Save"));
    await flush(5);
    expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({ token: SECRET });

    // Stored now: announced, never shown, and the typed value is gone from the page.
    expect(text(slot("token") as HTMLElement)).toContain("A token is stored.");
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(document.body.querySelector("#updates-token")).toBeNull();
  });

  it("announces a stored token without its value, and replaces it on request", async () => {
    const stored = updatesFixture({
      settings: { enabled: true, channel: "stable", sourceUrl: null, tokenSet: true },
    });
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(stored),
      "PATCH /updates/settings": () => json(stored),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    expect(text(slot("token") as HTMLElement)).toContain("A token is stored.");
    expect(document.body.querySelector("#updates-token")).toBeNull();
    expect(buttonByText(document.body, "Replace")).not.toBeNull();
    expect(buttonByText(document.body, "Remove")).not.toBeNull();

    await click(buttonByText(document.body, "Replace"));
    const input = document.body.querySelector<HTMLInputElement>("#updates-token");
    expect(input?.type).toBe("password");
    expect(input?.value).toBe("");
    // An empty replacement is not a change.
    expect(buttonByText(document.body, "Save")?.disabled).toBe(true);
    await typeInto(input, SECRET);
    expect(buttonByText(document.body, "Save")?.disabled).toBe(false);
    await click(buttonByText(document.body, "Save"));
    await flush(5);
    expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({ token: SECRET });
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("removes a stored token on save, and undoes the removal", async () => {
    const stored = updatesFixture({
      settings: { enabled: true, channel: "stable", sourceUrl: null, tokenSet: true },
    });
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(stored),
      "PATCH /updates/settings": () => json(updatesFixture()),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    await click(buttonByText(document.body, "Remove"));
    expect(text(slot("token") as HTMLElement)).toContain(
      "The token will be removed when you save.",
    );
    expect(buttonByText(document.body, "Save")?.disabled).toBe(false);

    await click(buttonByText(document.body, "Undo"));
    expect(buttonByText(document.body, "Save")?.disabled).toBe(true);

    await click(buttonByText(document.body, "Remove"));
    await click(buttonByText(document.body, "Save"));
    await flush(5);
    expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({ token: null });
    expect(text(slot("token") as HTMLElement)).not.toContain("A token is stored.");
  });
});

describe("the updater", () => {
  it("does not offer an install button when no updater runs, and shows the manual steps instead", () => {
    const root = show(
      updatesFixture({
        updater: {
          state: "unavailable",
          blockers: [],
          incompatible: false,
          selfUpdate: null,
          applicationImage: null,
          version: null,
          runner: null,
          signatureChecks: null,
          dumps: [],
          checkedAt: null,
        },
      }),
    );
    const updater = slot("updater", root) as HTMLElement;
    expect(updater.dataset.state).toBe("unavailable");
    expect(buttonByText(root, "Install update")).toBeNull();
    expect(text(slot("updater-unavailable", root) as HTMLElement)).toContain(
      "The updater is not running",
    );

    const steps = text(slot("manual-steps", root) as HTMLElement);
    for (const command of [
      "docker compose pull",
      "docker compose up -d",
      "git fetch --tags",
      "git checkout v0.2.0",
      "docker compose up -d --build",
    ]) {
      expect(steps, command).toContain(command);
    }
    // The default mode comes first and is marked.
    expect(text(root.querySelector('[data-mode="image"]') as HTMLElement)).toContain("Your setup");

    const enable = text(slot("enable-updater", root) as HTMLElement);
    expect(enable).toContain("docker compose --profile updater up -d");
    // The source setting does not start it, and there is no separate image to find.
    expect(text(slot("updater-unavailable", root) as HTMLElement)).toContain(
      "it does not start the updater",
    );
    expect(text(slot("updater-image-note", root) as HTMLElement)).toContain(
      "There is no separate updater image",
    );
    expect(text(slot("socket-warning", root) as HTMLElement)).toContain("mounts the Docker socket");
    expect(text(slot("socket-warning", root) as HTMLElement)).toContain("root access to the host");
    // Every command can be copied.
    expect(
      root.querySelectorAll('button[aria-label="Copy command"]').length,
    ).toBeGreaterThanOrEqual(6);
  });

  it("puts the build steps first for a source installation", () => {
    const root = show(
      updatesFixture({
        mode: "source",
        updater: {
          state: "unavailable",
          blockers: [],
          incompatible: false,
          selfUpdate: null,
          applicationImage: null,
          version: null,
          runner: null,
          signatureChecks: null,
          dumps: [],
          checkedAt: null,
        },
      }),
    );
    const modes = [...root.querySelectorAll<HTMLElement>("[data-mode]")].map(
      (node) => node.dataset.mode,
    );
    expect(modes.indexOf("source")).toBeLessThan(modes.indexOf("image"));
  });

  it("asks to recreate an updater that speaks another protocol", () => {
    const root = show(
      updatesFixture({
        updater: {
          state: "unavailable",
          blockers: [],
          incompatible: true,
          selfUpdate: null,
          applicationImage: null,
          version: "0.0.9",
          runner: "cli",
          signatureChecks: true,
          dumps: [],
          checkedAt: null,
        },
      }),
    );
    const note = slot("updater-incompatible", root) as HTMLElement;
    expect(text(note)).toContain("must be recreated");
    expect(text(note)).toContain("docker compose --profile updater up -d updater");
    expect(buttonByText(root, "Install update")).toBeNull();
    expect(slot("updater-unavailable", root)).toBeNull();
  });

  it("hints at an updater that runs another version than the installation", async () => {
    const root = show(
      updatesFixture({
        updater: { ...updatesFixture().updater, version: "0.0.9" },
      }),
    );
    const note = slot("updater-outdated", root) as HTMLElement;
    expect(text(note)).toContain(
      "The updater runs version 0.0.9 while this installation runs 0.1.0",
    );
    expect(text(note)).toContain("docker compose --profile updater up -d updater");
    // An updater on the same version says nothing.
    await mounted?.unmount();
    mounted = null;
    const same = show(updatesFixture());
    expect(slot("updater-outdated", same)).toBeNull();
  });

  it("says when the updater is replacing itself, and shows a failed self-update with the command", async () => {
    const record = {
      status: "pending" as const,
      reason: null,
      fromVersion: "0.0.9",
      targetVersion: "0.1.0",
      image: `ghcr.io/restow-backup/restow:0.1.0@sha256:${"a".repeat(64)}`,
      startedAt: "2026-10-03T10:00:00.000Z",
      finishedAt: null,
      detail: "",
    };
    const base = updatesFixture().updater;
    const pending = show(
      updatesFixture({
        updater: {
          ...base,
          version: "0.0.9",
          selfUpdate: { enabled: true, verifiesSignatures: true, last: record },
        },
      }),
    );
    const note = slot("updater-outdated", pending) as HTMLElement;
    expect(note.dataset.kind).toBe("pending");
    expect(text(note)).toContain("moving itself to version 0.1.0");
    await mounted?.unmount();
    mounted = null;

    const failed = show(
      updatesFixture({
        updater: {
          ...base,
          version: "0.0.9",
          selfUpdate: {
            enabled: true,
            verifiesSignatures: true,
            last: { ...record, status: "failed", reason: "helper_failed", detail: "exit code 1" },
          },
        },
      }),
    );
    const warning = slot("updater-outdated", failed) as HTMLElement;
    expect(warning.dataset.kind).toBe("failed");
    expect(text(warning)).toContain("Recreating the updater failed.");
    expect(text(warning)).toContain("exit code 1");
    expect(text(warning)).toContain("docker compose --profile updater up -d updater");
    expect(text(warning)).not.toContain("RESTOW_UPDATER_IMAGE=ghcr.io");
  });

  it("asks to move an updater that cannot update itself once, with the .env line", () => {
    const root = show(
      updatesFixture({
        updater: { ...updatesFixture().updater, version: "0.0.9", selfUpdate: null },
      }),
    );
    const note = slot("updater-outdated", root) as HTMLElement;
    expect(note.dataset.kind).toBe("legacy");
    expect(text(note)).toContain("RESTOW_UPDATER_IMAGE=ghcr.io/restow-backup/restow:0.1.0");
    expect(text(note)).toContain("docker compose --profile updater up -d updater");
  });

  it("lists what blocks the updater, translated, with the detail, and nothing to install", () => {
    const root = show(
      updatesFixture({
        updater: {
          state: "blocked",
          blockers: [
            { code: "disk_space", detail: "1.2 GB free, 4 GB needed" },
            { code: "docker_unreachable", detail: null },
          ],
          incompatible: false,
          selfUpdate: null,
          applicationImage: null,
          version: "0.1.0",
          runner: "cli",
          signatureChecks: true,
          dumps: [],
          checkedAt: iso(-10),
        },
      }),
    );
    const blocked = slot("updater-blocked", root) as HTMLElement;
    expect(text(blocked)).toContain("Updates are blocked");
    expect(text(blocked)).toContain("Nothing can be installed until this is fixed");
    const disk = root.querySelector('[data-blocker="disk_space"]') as HTMLElement;
    expect(text(disk)).toContain("not enough free disk space");
    expect(text(disk)).toContain("1.2 GB free, 4 GB needed");
    expect(
      text(root.querySelector('[data-blocker="docker_unreachable"]') as HTMLElement),
    ).toContain("cannot reach Docker");
    expect(buttonByText(root, "Install update")).toBeNull();
    // Updating by hand stays possible, folded away.
    expect(buttonByText(root, "Update by hand")).not.toBeNull();
  });

  it("lists the kept database backups", () => {
    const root = show(
      updatesFixture({
        updater: {
          ...updatesFixture().updater,
          dumps: [
            {
              file: "restow-0.1.0-2026-09-29.dump",
              bytes: 5 * 1024 * 1024,
              createdAt: iso(-86400),
            },
            { file: "restow-0.0.9-2026-09-01.dump", bytes: 1024, createdAt: iso(-86400 * 28) },
          ],
        },
      }),
    );
    const dumps = text(slot("dumps", root) as HTMLElement);
    expect(dumps).toContain("restow-0.1.0-2026-09-29.dump");
    expect(dumps).toContain("5 MB");
    expect(dumps).toContain("restow-0.0.9-2026-09-01.dump");
    expect(dumps).toContain("1 kB");
  });

  it("says when there is no backup yet", () => {
    const root = show(updatesFixture());
    expect(text(slot("dumps-empty", root) as HTMLElement)).toContain("No backup yet");
  });

  it("offers nothing to install when no release is newer", () => {
    const root = show(updatesFixture({ releases: [], updateAvailable: false }));
    expect(buttonByText(root, "Install update")).toBeNull();
    expect(text(slot("nothing-to-install", root) as HTMLElement)).toContain("no newer release");
  });

  it("is read-only in the public demo, with the version information still shown", () => {
    const root = show(
      updatesFixture({
        demo: true,
        updater: { ...updatesFixture().updater, state: "demo" },
      }),
    );
    expect(text(slot("demo-note", root) as HTMLElement)).toContain("public demo");
    expect(buttonByText(root, "Install update")).toBeNull();
    expect(buttonByText(root, "Save")?.disabled).toBe(true);
    expect(buttonByText(root, "Check now")?.disabled).toBe(true);
    expect((root.querySelector("#updates-check-enabled") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector("#updates-source-url") as HTMLInputElement).disabled).toBe(true);
    expect(text(root)).toContain("Update available: 0.2.0");
    expect(root.querySelector('[data-slot="access-note"]')?.getAttribute("data-reason")).toBe(
      "demo",
    );
  });
});

describe("installing an update", () => {
  const twoReleases = () => {
    const newest = releaseFixture();
    const older = releaseFixture({
      version: "0.1.1",
      tag: "v0.1.1",
      publishedAt: "2026-09-20T12:00:00.000Z",
      notes: "Fix",
    });
    return updatesFixture({ latest: newest, releases: [newest, older] });
  };

  it("asks which version and when, with what happens, and posts the choice", async () => {
    const view = twoReleases();
    const busy = updatesFixture({
      ...view,
      updater: { ...view.updater, state: "busy" },
      maintenance: maintenanceFixture({
        phase: "scheduled",
        runId: "r-2",
        targetVersion: "0.1.1",
        startsAt: iso(3600),
      }),
    });
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(view),
      "POST /updates/maintenance": () => json(busy),
      "GET /maintenance": () => json(maintenanceFixture()),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    const invalidate = vi.spyOn(mounted.queryClient, "invalidateQueries");
    await flush(5);

    await click(buttonByText(document.body, "Install update"));
    const confirm = dialog() as HTMLElement;
    expect(confirm).not.toBeNull();
    const content = text(confirm);
    expect(content).toContain("Install an update");
    // What will happen.
    expect(content).toContain("unavailable for a short time");
    expect(content).toContain("The last three backups are kept");
    expect(content).toContain("previous version is restored automatically");
    expect(content).toContain("Everyone who is signed in sees a countdown");
    expect(content).toContain("The release image is downloaded from the registry");
    // The newest version and five minutes are chosen by default.
    expect(
      (confirm.querySelector('input[name="update-version"]:checked') as HTMLInputElement).value,
    ).toBe("0.2.0");
    expect(
      (confirm.querySelector('input[name="update-lead"]:checked') as HTMLInputElement).value,
    ).toBe("300");
    // Every lead time of the api is offered, translated.
    for (const label of [
      "Start immediately",
      "In 1 minute",
      "In 5 minutes",
      "In 15 minutes",
      "In 30 minutes",
      "In 1 hour",
    ]) {
      expect(content, label).toContain(label);
    }

    await click(confirm.querySelector('input[name="update-version"][value="0.1.1"]'));
    await click(confirm.querySelector('input[name="update-lead"][value="3600"]'));
    await click(buttonByText(confirm, "Announce update"));
    await flush(5);

    const post = requests.find(
      (request) => request.method === "POST" && request.path === "/updates/maintenance",
    );
    expect(post?.body).toEqual({ version: "0.1.1", leadSeconds: 3600 });
    expect(dialog()).toBeNull();
    // The busy state shows at once, and the shell is told to re-read.
    expect(slot("updater-busy")?.dataset.phase).toBe("scheduled");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["updates", "maintenance"] });
  });

  it("starts at once when the lead time is zero, and says so on the button", async () => {
    const view = twoReleases();
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(view),
      "POST /updates/maintenance": () => json(view),
      "GET /maintenance": () => json(maintenanceFixture()),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    await click(buttonByText(document.body, "Install update"));
    const confirm = dialog() as HTMLElement;
    await click(confirm.querySelector('input[name="update-lead"][value="0"]'));
    expect(buttonByText(confirm, "Start update now")).not.toBeNull();
    await click(buttonByText(confirm, "Start update now"));
    await flush(5);
    expect(
      requests.find(
        (request) => request.method === "POST" && request.path === "/updates/maintenance",
      )?.body,
    ).toEqual({
      version: "0.2.0",
      leadSeconds: 0,
    });
  });

  it("explains a build from source, and warns about a pre-release", async () => {
    const release = releaseFixture({ prerelease: true, version: "0.3.0-rc.1", tag: "v0.3.0-rc.1" });
    const view = updatesFixture({ mode: "source", latest: release, releases: [release] });
    mounted = mount(<UpdatesContent view={view} receivedAt={NOW} canManage />);
    await flush();
    await click(buttonByText(document.body, "Install update"));
    const content = text(dialog() as HTMLElement);
    expect(content).toContain("built on this server from the repository at tag v0.3.0-rc.1");
    expect(content).toContain("This is a pre-release");
  });

  it("does not offer to build from a source the operator has not allowed, and says how to allow it", async () => {
    const view = updatesFixture({
      mode: "source",
      sourceAllowed: false,
      settings: { ...updatesFixture().settings, sourceUrl: "https://git.example.com/Acme/restow" },
      source: {
        origin: "settings",
        url: "https://git.example.com/Acme/restow",
        provider: "forgejo",
        repository: "Acme/restow",
        isDefault: false,
        isAlpha: false,
      },
    });
    const root = show(view);
    const note = slot("source-not-allowed", root) as HTMLElement;
    expect(text(note)).toContain("Building from this source is turned off");
    expect(text(note)).toContain("RESTOW_UPDATER_SOURCE_HOSTS=git.example.com/acme/restow");
    expect(text(note)).toContain("docker compose --profile updater up -d updater");
    expect((buttonByText(root, "Install update") as HTMLButtonElement).disabled).toBe(true);
    // An allowed source, and every image update, has no such note.
    await mounted?.unmount();
    mounted = null;
    const allowed = show({ ...view, sourceAllowed: true });
    expect(slot("source-not-allowed", allowed)).toBeNull();
    expect((buttonByText(allowed, "Install update") as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not offer to install a release without an image digest", async () => {
    const release = releaseFixture({ digests: {} });
    const view = updatesFixture({ latest: release, releases: [release] });
    mounted = mount(<UpdatesContent view={view} receivedAt={NOW} canManage />);
    await flush();
    await click(buttonByText(document.body, "Install update"));
    const content = dialog() as HTMLElement;
    expect(text(content)).toContain("publishes no image digest");
    expect((buttonByText(content, "Announce update") as HTMLButtonElement).disabled).toBe(true);
  });

  it("stays open with the cause when the api refuses", async () => {
    const view = twoReleases();
    const { mock } = routedFetch({
      "GET /updates": () => json(view),
      "POST /updates/maintenance": () => problem("urn:restow:problem:update-busy", 409),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    await click(buttonByText(document.body, "Install update"));
    await click(buttonByText(dialog() as HTMLElement, "Announce update"));
    await flush(5);
    expect(dialog()).not.toBeNull();
    expect(text(dialog() as HTMLElement)).toContain("An update is already announced or running.");
  });

  it("asks to confirm it is you before an update is announced from an older session", async () => {
    const view = twoReleases();
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(view),
      "POST /updates/maintenance": () =>
        problem("urn:restow:problem:recent-sign-in-required", 403, { maxAgeSeconds: 600 }),
      "GET /setup/state": () =>
        json({ passkeyReady: { ready: false, reasons: [], rpId: null, origin: null } }),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);
    await click(buttonByText(document.body, "Install update"));
    await click(buttonByText(dialog() as HTMLElement, "Announce update"));
    await flush(5);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(text(dialog() as HTMLElement)).toContain("Confirm it is you first");
    const confirm = slot("confirm-identity") as HTMLElement;
    expect(confirm).not.toBeNull();
    expect(text(confirm)).toContain("Confirm it is you");
  });

  it("names the cause for every updater problem type", async () => {
    const cases: [string, string][] = [
      ["urn:restow:problem:updater-unavailable", "The updater is not running"],
      ["urn:restow:problem:updater-blocked", "cannot install updates right now"],
      ["urn:restow:problem:update-version-unknown", "not among the releases of the last check"],
      ["urn:restow:problem:update-running-unknown", "reports no release version"],
      ["urn:restow:problem:update-source-not-allowed", "allow the repository first"],
      ["urn:restow:problem:update-not-verifiable", "cannot verify it"],
      ["urn:restow:problem:demo-read-only", "public demo"],
    ];
    for (const [type, expected] of cases) {
      const view = twoReleases();
      const { mock } = routedFetch({
        "GET /updates": () => json(view),
        "POST /updates/maintenance": () => problem(type, 409),
      });
      vi.stubGlobal("fetch", mock);
      mounted = mount(<UpdatesSection />);
      await flush(5);
      await click(buttonByText(document.body, "Install update"));
      await click(buttonByText(dialog() as HTMLElement, "Announce update"));
      await flush(5);
      expect(text(dialog() as HTMLElement), type).toContain(expected);
      await mounted.unmount();
      mounted = null;
      document.body.innerHTML = "";
    }
  });
});

describe("an announced or running update", () => {
  it("shows the countdown on the server's clock and cancels on confirmation", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(NOW);
    const view = updatesFixture({
      updater: { ...updatesFixture().updater, state: "busy" },
      maintenance: maintenanceFixture({
        phase: "scheduled",
        runId: "r-2",
        targetVersion: "0.2.0",
        startsAt: iso(272),
        serverTime: iso(0),
      }),
      run: runFixture({
        id: "r-2",
        outcome: null,
        startedAt: null,
        finishedAt: null,
        progress: 0,
        startsAt: iso(272),
        steps: [],
      }),
    });
    const cancelled = updatesFixture({
      ...view,
      maintenance: maintenanceFixture(),
      run: null,
      updater: { ...view.updater, state: "ready" },
    });
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(`${init?.method ?? "GET"} ${new URL(String(input), "http://x").pathname}`);
        return json(init?.method === "DELETE" ? cancelled : view);
      }),
    );
    mounted = mount(<UpdatesSection />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    const countdown = slot("busy-countdown") as HTMLElement;
    expect(text(countdown)).toContain("Starts in 04:32");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(text(slot("busy-countdown") as HTMLElement)).toContain("Starts in 04:30");

    await click(buttonByText(document.body, "Cancel maintenance"));
    expect(text(dialog() as HTMLElement)).toContain("Cancel the announced update?");
    await click(buttonByText(dialog() as HTMLElement, "Cancel maintenance"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(requests).toContain("DELETE /api/v1/updates/maintenance");
    expect(slot("updater-busy")).toBeNull();
  });

  it("cannot cancel once it runs", () => {
    const root = show(
      updatesFixture({
        updater: { ...updatesFixture().updater, state: "busy" },
        maintenance: maintenanceFixture({
          phase: "running",
          runId: "r-2",
          targetVersion: "0.2.0",
          progress: 40,
        }),
        run: runFixture({
          id: "r-2",
          outcome: null,
          finishedAt: null,
          progress: 40,
          step: "fetch",
          steps: [
            { id: "prepare", status: "done", startedAt: null, finishedAt: null, detail: {} },
            { id: "fetch", status: "running", startedAt: null, finishedAt: null, detail: {} },
          ],
          message: {
            code: "step.fetch.pulling",
            params: { image: "ghcr.io/restow-backup/restow:0.2.0" },
          },
        }),
      }),
    );
    expect(buttonByText(root, "Cancel maintenance")).toBeNull();
    expect(text(root)).toContain("cannot be cancelled any more");
    const run = slot("run", root) as HTMLElement;
    expect(run.dataset.status).toBe("running");
    expect(text(run)).toContain("Downloading ghcr.io/restow-backup/restow:0.2.0");
    expect(text(run)).toContain("Preparing the update");
    expect(run.querySelector('[data-step="fetch"]')?.getAttribute("data-status")).toBe("running");
    expect(run.querySelector('[data-step="backup"]')?.getAttribute("data-status")).toBe("pending");
  });
});

describe("the run panel", () => {
  it("shows a succeeded run and clears it on request", async () => {
    const done = updatesFixture({
      running: "0.2.0",
      latest: releaseFixture(),
      updateAvailable: false,
      releases: [],
      maintenance: maintenanceFixture({
        phase: "succeeded",
        runId: "r-1",
        outcome: "succeeded",
        targetVersion: "0.2.0",
      }),
      run: runFixture(),
    });
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(done),
      "POST /updates/maintenance/dismiss": () =>
        json(updatesFixture({ running: "0.2.0", run: null, releases: [], updateAvailable: false })),
      "GET /maintenance": () => json(maintenanceFixture()),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    const run = slot("run") as HTMLElement;
    expect(run.dataset.status).toBe("succeeded");
    expect(text(run)).toContain("Last update");
    expect(text(run)).toContain("Version 0.1.0 to 0.2.0");
    expect(text(run)).toContain("Succeeded");
    expect(text(run)).toContain("owner@example.test");
    expect(text(run)).toContain("The new version is running.");

    await click(buttonByText(run, "Dismiss"));
    await flush(5);
    expect(requests.some((request) => request.path === "/updates/maintenance/dismiss")).toBe(true);
    expect(slot("run")).toBeNull();
  });

  it("words the run of a build switch as a switch, not as an update", async () => {
    const done = updatesFixture({
      running: "0.2.1",
      latest: releaseFixture(),
      updateAvailable: false,
      releases: [],
      maintenance: maintenanceFixture(),
      run: runFixture({
        switchTo: "full",
        fromVersion: "0.2.1",
        targetVersion: "0.2.1",
        message: { code: "run.succeeded", params: { version: "0.2.1" } },
      }),
    });
    const { mock } = routedFetch({
      "GET /updates": () => json(done),
      "GET /maintenance": () => json(maintenanceFixture()),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    const run = slot("run") as HTMLElement;
    expect(text(run)).toContain("Last switch of the build");
    expect(text(run)).toContain("Switch to the full build (0.2.1)");
    expect(text(run)).toContain("The full build is running.");
    expect(text(run)).toContain("Switched to the full build (0.2.1).");
    expect(text(run)).not.toContain("Last update");
    expect(text(run)).not.toContain("Version 0.2.1 to 0.2.1");
  });

  it("explains a failure that changed nothing and one that was rolled back", async () => {
    const base = {
      maintenance: maintenanceFixture({ phase: "failed", runId: "r-1" }),
    };
    const unchanged = show(
      updatesFixture({
        ...base,
        run: runFixture({
          outcome: "unchanged",
          finishedAt: iso(-10),
          failure: {
            code: "fetch.pull_failed",
            step: "fetch",
            detail: "manifest unknown",
            migrationsRan: false,
          },
        }),
      }),
    );
    const failure = text(slot("run", unchanged) as HTMLElement);
    expect(failure).toContain("Failed, unchanged");
    expect(failure).toContain("The new image could not be downloaded.");
    expect(failure).toContain("Failed in step: Downloading the new version");
    expect(failure).toContain("No database migration had run.");
    expect(failure).toContain("manifest unknown");
    expect(failure).toContain("The previous version never stopped");
    await mounted?.unmount();
    mounted = null;

    const rolledBack = show(
      updatesFixture({
        ...base,
        run: runFixture({
          outcome: "rolled_back",
          failure: { code: "health.timeout", step: "health", detail: "", migrationsRan: false },
        }),
      }),
    );
    const text2 = text(slot("run", rolledBack) as HTMLElement);
    expect(text2).toContain("Failed, rolled back");
    expect(text2).toContain("The new version did not become healthy in time.");
    expect(text2).toContain("The previous version runs again.");
  });

  it("says whether the release signature was verified", async () => {
    const cases: [Partial<ReturnType<typeof runFixture>>, string][] = [
      [{ signatureVerified: true }, "Verified: signed by the release workflow of this version"],
      [{ signatureVerified: false }, "Not checked: signature verification is switched off"],
      [
        {
          signatureVerified: false,
          outcome: "unchanged",
          failure: {
            code: "fetch.signature_invalid",
            step: "fetch",
            detail: "no matching signatures",
            migrationsRan: false,
          },
        },
        "Not valid: the image was not used",
      ],
    ];
    for (const [overrides, expected] of cases) {
      const root = show(updatesFixture({ run: runFixture(overrides) }));
      expect(text(slot("run-signature", root) as HTMLElement)).toContain(expected);
      await mounted?.unmount();
      mounted = null;
    }
    const source = show(
      updatesFixture({ run: runFixture({ mode: "source", signatureVerified: null }) }),
    );
    expect(slot("run-signature", source)).toBeNull();
  });

  it("keeps the redacted log tail folded away", async () => {
    const root = show(
      updatesFixture({
        maintenance: maintenanceFixture({ phase: "succeeded" }),
        run: runFixture({ log: ["pulling image", "done"] }),
      }),
    );
    expect(text(root)).not.toContain("pulling image");
    await click(buttonByText(root, "Show log"));
    expect(text(root)).toContain("pulling image");
    expect(text(root)).toContain("Secrets are removed");
  });

  it("says a cancelled run changed nothing", () => {
    const root = show(
      updatesFixture({
        run: runFixture({
          cancelled: true,
          cancelledAt: iso(-5),
          outcome: null,
          finishedAt: null,
          startedAt: null,
          steps: [],
        }),
      }),
    );
    const run = slot("run", root) as HTMLElement;
    expect(run.dataset.status).toBe("cancelled");
    expect(text(run)).toContain("cancelled before it started");
  });

  it("shows the recovery commands of a run that needs attention, and dismisses after a confirmation", async () => {
    const attention = updatesFixture({
      updater: { ...updatesFixture().updater, state: "ready" },
      maintenance: maintenanceFixture({
        phase: "failed",
        runId: "r-1",
        outcome: "needs_attention",
      }),
      run: runFixture({
        outcome: "needs_attention",
        failure: { code: "start.failed", step: "start", detail: "", migrationsRan: true },
        recovery: {
          dumpFile: "restow-0.1.0-2026-09-30.dump",
          dumpBytes: 12 * 1024 * 1024,
          fromVersion: "0.1.0",
          previousImages: { app: "ghcr.io/restow-backup/restow:0.1.0", web: null },
        },
      }),
    });
    const { mock, requests } = routedFetch({
      "GET /updates": () => json(attention),
      "POST /updates/maintenance/dismiss": () => json(updatesFixture()),
      "GET /maintenance": () => json(maintenanceFixture()),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);

    const recovery = slot("recovery") as HTMLElement;
    expect(recovery.getAttribute("role")).toBe("alert");
    expect(text(recovery)).toContain("The update needs your attention");
    expect(text(recovery)).toContain(
      "restow-0.1.0-2026-09-30.dump (12 MB), taken at version 0.1.0",
    );
    const commands = [...recovery.querySelectorAll("code")].map((node) => node.textContent);
    expect(commands).toEqual([
      "docker compose --profile updater cp updater:/state/dumps/restow-0.1.0-2026-09-30.dump ./restow-0.1.0-2026-09-30.dump",
      "docker compose stop api worker scheduler",
      "docker compose exec -T postgres pg_restore -U restow -d restow --clean --if-exists < restow-0.1.0-2026-09-30.dump",
      "RESTOW_IMAGE=ghcr.io/restow-backup/restow:0.1.0",
      "docker compose up -d",
    ]);
    // A variable that was not set before the update is removed, not set to nothing.
    expect(text(recovery)).toContain(
      "Remove these lines from .env if they are there: RESTOW_WEB_IMAGE",
    );
    expect(recovery.querySelectorAll('button[aria-label="Copy command"]').length).toBe(4);
    expect(recovery.querySelectorAll('button[aria-label="Copy line"]').length).toBe(1);
    expect(buttonByText(recovery, "Copy all commands")).not.toBeNull();
    expect(text(slot("run") as HTMLElement)).toContain(
      "The new version did not start after the database was migrated",
    );
    expect(text(slot("run-failure") as HTMLElement)).toContain(
      "The new version could not be started.",
    );
    expect(text(slot("run-failure") as HTMLElement)).toContain("Database migrations had run.");

    await click(buttonByText(slot("run") as HTMLElement, "Dismiss"));
    expect(text(dialog() as HTMLElement)).toContain("Dismiss this notice?");
    expect(requests.some((request) => request.path === "/updates/maintenance/dismiss")).toBe(false);
    await click(buttonByText(dialog() as HTMLElement, "Dismiss"));
    await flush(5);
    expect(requests.some((request) => request.path === "/updates/maintenance/dismiss")).toBe(true);
    expect(slot("recovery")).toBeNull();
  });

  it("puts both image references back when the run knew both", () => {
    const root = show(
      updatesFixture({
        maintenance: maintenanceFixture({ phase: "failed", outcome: "needs_attention" }),
        run: runFixture({
          outcome: "needs_attention",
          recovery: {
            dumpFile: "a b.dump",
            dumpBytes: null,
            fromVersion: null,
            previousImages: { app: "restow:local", web: "restow-web:local" },
          },
        }),
      }),
    );
    const commands = [...(slot("recovery", root) as HTMLElement).querySelectorAll("code")].map(
      (node) => node.textContent,
    );
    // A file name with a space is quoted for the shell.
    expect(commands[0]).toBe(
      "docker compose --profile updater cp updater:/state/dumps/'a b.dump' ./'a b.dump'",
    );
    expect(commands).toContain("RESTOW_IMAGE=restow:local");
    expect(commands).toContain("RESTOW_WEB_IMAGE=restow-web:local");
    expect(text(slot("recovery", root) as HTMLElement)).not.toContain("Remove these lines");
  });
});

describe("who may change what", () => {
  it("lets a lower provider role look but not change anything", () => {
    const root = show(updatesFixture(), { canManage: false });
    expect(root.querySelector('[data-slot="access-note"]')?.getAttribute("data-reason")).toBe(
      "role",
    );
    expect(text(root)).toContain("needs the Owner role in the provider team");
    // The information is all there.
    expect(text(root)).toContain("Update available: 0.2.0");
    expect(text(root)).toContain("Available releases");
    // Nothing that changes something is enabled.
    expect(buttonByText(root, "Install update")?.disabled).toBe(true);
    expect(buttonByText(root, "Check now")?.disabled).toBe(true);
    expect(buttonByText(root, "Save")?.disabled).toBe(true);
    expect((root.querySelector("#updates-check-enabled") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector("#updates-source-url") as HTMLInputElement).disabled).toBe(true);
    expect(
      (root.querySelector('input[name="updates-channel"][value="beta"]') as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });

  it("reads the role from the session", async () => {
    const { mock } = routedFetch({ "GET /updates": () => json(updatesFixture()) });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />, {
      session: sessionAs({ providerRole: "administrator" }),
    });
    await flush(5);
    expect(buttonByText(document.body, "Install update")?.disabled).toBe(true);
    await mounted.unmount();
    document.body.innerHTML = "";

    mounted = mount(<UpdatesSection />, { session: sessionAs({ providerRole: "owner" }) });
    await flush(5);
    expect(buttonByText(document.body, "Install update")?.disabled).toBe(false);
    expect(document.body.querySelector('[data-slot="access-note"]')).toBeNull();
  });

  it("keeps showing the last state when a refresh fails", async () => {
    const view = updatesFixture();
    let calls = 0;
    const { mock } = routedFetch({
      "GET /updates": () => {
        calls += 1;
        return calls === 1 ? json(view) : problem("about:blank", 503);
      },
      "POST /updates/check": () => problem("about:blank", 503),
    });
    vi.stubGlobal("fetch", mock);
    mounted = mount(<UpdatesSection />);
    await flush(5);
    await act(async () => {
      await mounted?.queryClient.refetchQueries();
    });
    await flush(3);
    expect(text(slot("refresh-failed") as HTMLElement)).toContain("last state it received");
    expect(text()).toContain("Update available: 0.2.0");
  });
});

// Keep the fixtures honest: the idle maintenance view is what the api sends when nothing is going on.
describe("fixtures", () => {
  it("start from an idle maintenance", () => {
    expect(updatesFixture().maintenance.phase).toBe(idleMaintenance().phase);
  });
});
