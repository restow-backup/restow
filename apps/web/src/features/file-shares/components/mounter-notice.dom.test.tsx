// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { click, enableActEnvironment, flush, json } from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { settingsFixture } from "../fixtures.js";
import "../i18n.js";
import { type Rendered, action, providerOwner, render, slot, tenantAdmin } from "../testing.js";
import { MounterNotice } from "./mounter-notice.js";

/**
 * The notice of the file share pages while the mounter is off (docs/FILESHARES.md 3.9):
 * "Enable network shares" for the provider owner when the opt-in updater can start the
 * mounter, the command otherwise, and nothing to click for tenant admins.
 */

enableActEnvironment();

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

const OFF = settingsFixture({
  runner: { available: false, ready: false, blockers: [], running: 0, limit: null },
  enableCommand: "docker compose --profile mounts up -d mounter",
});

function mountsView(via: "updater" | "command" | null, available = false) {
  return {
    available,
    unavailableReason: available ? null : "unreachable",
    demo: false,
    enableCommand: "docker compose --profile mounts up -d mounter",
    mountRoot: "/mnt/restow",
    state: null,
    pending: null,
    enable: {
      running: available,
      via,
      command: "docker compose --profile mounts up -d mounter",
      disableCommand: "docker compose --profile mounts stop mounter",
      lastAttempt: null,
    },
  };
}

describe("MounterNotice", () => {
  it("offers Enable network shares to the owner and sends it", async () => {
    let current = mountsView("updater");
    rendered = await render(<MounterNotice settings={OFF} />, {
      session: providerOwner(),
      routes: {
        "GET /mounts": () => json(current),
        "POST /mounts/enable": () => {
          current = mountsView(null, true);
          return json(current);
        },
      },
    });
    await flush(6);
    const notice = slot("mounter-notice");
    expect(notice?.textContent).toContain("Start it from here");
    expect(notice?.textContent).toContain("docker compose --profile mounts up -d mounter");
    const button = action("enable-mounter");
    expect(button).not.toBeNull();
    await click(button as HTMLElement);
    await flush(6);
    expect(
      rendered.requests.some(
        (request) => request.method === "POST" && request.path === "/mounts/enable",
      ),
    ).toBe(true);
  });

  it("shows only the command when no updater can start it", async () => {
    rendered = await render(<MounterNotice settings={OFF} />, {
      session: providerOwner(),
      routes: { "GET /mounts": () => json(mountsView("command")) },
    });
    await flush(6);
    expect(action("enable-mounter")).toBeNull();
    expect(slot("mounter-notice")?.textContent).toContain("Run this command on the server");
    expect(slot("mounter-command")?.textContent).toContain("up -d mounter");
  });

  it("asks nothing of the mounts for a tenant admin", async () => {
    rendered = await render(<MounterNotice settings={OFF} />, { session: tenantAdmin() });
    await flush(4);
    expect(action("enable-mounter")).toBeNull();
    expect(rendered.requests.some((request) => request.path === "/mounts")).toBe(false);
    expect(slot("mounter-notice")?.textContent).toContain("does not back up file shares yet");
  });

  it("is not shown while the runner is ready", async () => {
    rendered = await render(<MounterNotice settings={settingsFixture()} />, {
      session: providerOwner(),
    });
    expect(slot("mounter-notice")).toBeNull();
    expect(rendered.requests).toEqual([]);
  });
});
