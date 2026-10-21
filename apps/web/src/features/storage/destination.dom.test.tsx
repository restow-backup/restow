// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { type Rendered, render, slot, TENANT, tenantAdmin } from "@/features/file-shares/testing";
import { json } from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { type BackupDestination, BackupDestinationNote, ServerDiskWarning } from "./destination";
import "./i18n";

/**
 * Where backups land (docs/STORAGE.md, "Where backups land"): the one line shown wherever a
 * backup is started or configured, with the installation default on the server's local disk
 * highlighted, and the warning when backups land on the server's own disk.
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

const LOCAL_DEFAULT: BackupDestination = {
  targetId: null,
  name: null,
  installationDefault: true,
  kind: "local",
  location: null,
  onServerDisk: true,
  misconfigured: false,
};

const NAS: BackupDestination = {
  targetId: "target-1",
  name: "NAS",
  installationDefault: false,
  kind: "local",
  location: "/mnt/nas/restow",
  onServerDisk: false,
  misconfigured: false,
};

const BUCKET: BackupDestination = {
  targetId: "target-2",
  name: "Offsite Hetzner",
  installationDefault: false,
  kind: "s3",
  location: "s3://restow-backup (fsn1.your-objectstorage.com)",
  onServerDisk: false,
  misconfigured: false,
};

describe("BackupDestinationNote", () => {
  it("highlights the installation default on the server's local disk", async () => {
    rendered = await render(<BackupDestinationNote />, {
      routes: { "GET /storage/destination": () => json(LOCAL_DEFAULT) },
    });
    const note = slot("backup-destination");
    expect(note?.textContent).toContain("Backups land in:");
    expect(slot("backup-destination-default")?.textContent).toBe(
      "Installation default (local disk of the server)",
    );
  });

  it("names the tenant's own repository with its kind and where it is", async () => {
    rendered = await render(<BackupDestinationNote />, {
      routes: { "GET /storage/destination": () => json(BUCKET) },
    });
    const note = slot("backup-destination")?.textContent ?? "";
    expect(note).toContain("Offsite Hetzner");
    expect(note).toContain("S3-compatible object storage");
    expect(note).toContain("s3://restow-backup (fsn1.your-objectstorage.com)");
    expect(slot("backup-destination-default")).toBeNull();
  });

  it("asks nothing and shows nothing for a member who does not administer the tenant", async () => {
    const operator = { ...TENANT, role: "tenant_restore" as const };
    rendered = await render(<BackupDestinationNote />, {
      session: tenantAdmin({ activeTenant: operator, tenants: [operator] }),
      routes: { "GET /storage/destination": () => json(BUCKET) },
    });
    expect(slot("backup-destination")).toBeNull();
    expect(rendered.requests.some((r) => r.path === "/storage/destination")).toBe(false);
  });
});

describe("ServerDiskWarning", () => {
  it("warns when backups land on the server's own disk and links to the repositories", async () => {
    rendered = await render(<ServerDiskWarning />, {
      routes: { "GET /storage/destination": () => json(LOCAL_DEFAULT) },
    });
    const warning = slot("server-disk-warning");
    expect(warning?.textContent).toContain("Backups land on the server's own disk");
    expect(warning?.textContent).toContain("installation default");
    const link = warning?.querySelector("a");
    expect(link?.textContent).toBe("Choose another repository");
    expect(link?.getAttribute("href")).toBe(`/tenants/${TENANT.id}/storage`);
  });

  it("stays away for a network share or object storage", async () => {
    rendered = await render(
      <>
        <ServerDiskWarning destination={NAS} />
        <ServerDiskWarning destination={BUCKET} />
      </>,
    );
    expect(slot("server-disk-warning")).toBeNull();
  });
});
