// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveRun } from "./api";
import { RestoreCheckFacts, RestoreFindings } from "./restore-findings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(run: Pick<PveRun, "kind" | "status" | "stats" | "warnings">): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <RestoreFindings run={run} />
      </I18nextProvider>,
    );
  });
  return host;
}

describe("RestoreFindings", () => {
  it("names the mount points a restore left out, how to put them back and the shared-data risk", () => {
    const el = render({
      kind: "restore",
      status: "succeeded",
      stats: {
        vmid: 9002,
        omittedMounts: ["mp0: /mnt/paperless,mp=/data"],
        remountCommands: ["pct set 9002 -mp0 /mnt/paperless,mp=/data"],
      },
    });
    const item = el.querySelector('[data-finding="omittedMounts"]');
    expect(item?.textContent).toContain("Restored without this mount point");
    expect(item?.textContent).toContain("mp0: /mnt/paperless,mp=/data");
    expect(item?.textContent).toContain("pct set 9002 -mp0 /mnt/paperless,mp=/data");
    expect(item?.textContent).toContain("shares the live data of the original guest");
  });

  it("says a check did not cover them, without a command to put them back", () => {
    const el = render({
      kind: "restore_test",
      status: "succeeded",
      stats: { omittedMounts: ["mp0: /srv/a,mp=/a", "mp1: /dev/sdb1,mp=/b"], deleted: true },
    });
    const item = el.querySelector('[data-finding="omittedMounts"]');
    expect(item?.textContent).toContain("The check did not cover these mount points");
    expect(item?.textContent).toContain("mp1: /dev/sdb1,mp=/b");
    expect(item?.textContent).not.toContain("pct set");
  });

  it("names a temporary guest the check could not remove, and the restore's warnings", () => {
    const el = render({
      kind: "restore_test",
      status: "succeeded",
      stats: { deleted: false, leftoverVmid: 105, warnings: ["WARN: unable to set acl"] },
    });
    expect(el.querySelector('[data-finding="leftover"]')?.textContent).toContain(
      "The temporary guest 105 of this check is still there",
    );
    expect(el.querySelector('[data-finding="warnings"]')?.textContent).toContain(
      "WARN: unable to set acl",
    );
  });

  it("shows nothing for a clean restore", () => {
    const el = render({ kind: "restore", status: "succeeded", stats: { vmid: 9003 } });
    expect(el.querySelector('[data-slot="pve-restore-findings"]')).toBeNull();
  });
});

describe("RestoreCheckFacts", () => {
  it("says when the node cannot run the job's restore check, and nothing without one", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <RestoreCheckFacts
            facts={{
              enabled: true,
              blocker: "restores_off",
              node: "pve2",
              lastRestoreTestAt: null,
            }}
          />
          <RestoreCheckFacts
            facts={{ enabled: false, blocker: null, node: "pve2", lastRestoreTestAt: null }}
          />
        </I18nextProvider>,
      );
    });
    const lines = host.querySelectorAll('[data-slot="pve-restore-check-facts"]');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toBe(
      "Restore check not possible: restores are switched off on node pve2.",
    );
    expect(i18n.t("guest.restoreCheckSkipped", { ns: "pve", reason: "storage_space" })).toBe(
      "Not checked: not enough space",
    );
  });

  it("says a privileged container's restore point is not checked, and that Restow decides it", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <RestoreCheckFacts
            facts={{ enabled: true, blocker: "privileged", node: "pve1", lastRestoreTestAt: null }}
          />
        </I18nextProvider>,
      );
    });
    const line = host.querySelector('[data-slot="pve-restore-check-facts"]');
    expect(line?.textContent).toMatch(
      /^Not checked: privileged container\. .+ restores containers only as unprivileged/,
    );
    expect(line?.textContent).not.toContain("Proxmox VE cannot");
  });
});
