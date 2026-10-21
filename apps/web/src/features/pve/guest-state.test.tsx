import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveGuest, PveNode } from "./api";
import { GuestState } from "./pve-page";

/** The state cell of VMs & containers: what runs now and how the last backup ended. */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function guest(over: Partial<PveGuest> = {}): PveGuest {
  return {
    id: "g-1",
    clusterId: "c-1",
    vmid: 200,
    kind: "ct",
    name: "web",
    node: "pmx02",
    status: "running",
    template: false,
    privileged: false,
    present: true,
    diskBytes: 0,
    jobId: "j-1",
    jobName: "Nightly",
    lastBackupAt: null,
    lastSuccessAt: null,
    lastRunStatus: null,
    lastRunError: null,
    bitmapState: null,
    attention: [],
    ...over,
  } as PveGuest;
}

const render = (g: PveGuest, node?: PveNode | null) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <GuestState guest={g} node={node} />
    </I18nextProvider>,
  );

describe("GuestState", () => {
  it("says that a backup was handed to the node, then that it runs", () => {
    expect(render(guest({ activity: "queued" }))).toContain("Waiting for the node");
    expect(render(guest({ activity: "running" }))).toContain("Backup running");
    expect(render(guest())).not.toContain('data-slot="pve-guest-activity"');
  });

  it("says that a container's last backup succeeded, and why one failed", () => {
    expect(render(guest({ lastRunStatus: "succeeded" }))).toContain("Last backup succeeded");
    const failed = render(guest({ lastRunStatus: "failed", lastRunError: "restic backup failed" }));
    expect(failed).toContain("Last run failed");
    expect(failed).toContain("restic backup failed");
  });

  it("leaves a VM's success to its bitmap badge", () => {
    const html = render(
      guest({ kind: "vm", lastRunStatus: "succeeded", bitmapState: "incremental" }),
    );
    expect(html).not.toContain("Last backup succeeded");
    expect(html).toContain("Incremental");
  });

  it("turns the waiting badge amber while the guest's node is disconnected", () => {
    const node = {
      id: "n-1",
      name: "pmx02",
      online: false,
      lastSeenAt: "2026-10-15T09:00:00Z",
    } as PveNode;
    const html = render(guest({ activity: "queued", activitySince: "2026-10-15T10:00:00Z" }), node);
    expect(html).toContain("Node pmx02 is disconnected");
    expect(html).toContain('data-variant="warning"');
    expect(render(guest({ activity: "queued" }), { ...node, online: true })).not.toContain(
      "disconnected",
    );
  });

  it("shows a backup vzdump warned about as succeeded with warnings, not failed (C5)", () => {
    const html = render(
      guest({
        lastRunStatus: "succeeded",
        lastRunWarnings: ["WARN: unable to set notes"],
      }),
    );
    expect(html).toContain("Succeeded with warnings");
    expect(html).toContain('data-variant="warning"');
    expect(html).toContain("WARN: unable to set notes");
    expect(html).not.toContain("Last run failed");
    expect(html).not.toContain('data-variant="success"');
  });

  it("shows what a red restore check really found (B2)", () => {
    const error = "Fatal: repository does not exist: unable to open config file";
    const html = render(
      guest({ lastVerify: { state: "red", checkedAt: null, errors: [error], requested: false } }),
    );
    expect(html).toContain("Restore check failed");
    expect(html).toContain('data-slot="pve-guest-verify-error"');
    expect(html).toContain(error);
  });

  it("marks the VM the server runs in (C7)", () => {
    const html = render(guest({ restowServer: "detected" }));
    expect(html).toContain('data-slot="pve-guest-restow-server"');
    expect(html).toContain("SMBIOS UUID");
  });
});
