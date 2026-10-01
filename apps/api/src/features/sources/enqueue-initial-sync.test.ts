import type { Database } from "@restow/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `enqueueInitialDirectorySync`: the source that just connected (or turned
 * green with nothing synced yet) gets its first directory sync queued and
 * audited like a manual one — best effort, so a queueing hiccup never fails
 * the consent callback or a verification the admin is watching.
 */

const enqueueDirectorySync = vi.fn();
const audit = vi.fn();

vi.mock("../directory/enqueue.js", () => ({ enqueueDirectorySync }));
vi.mock("../../lib/audit.js", () => ({ audit }));

const { enqueueInitialDirectorySync } = await import("./service.js");

const db = {} as Database;
const tenantId = "0b3f6b2e-9c2d-4c3a-9e7f-1d2c3b4a5f60";
const sourceId = "7d8e9f00-1111-2222-3333-444455556666";

beforeEach(() => {
  enqueueDirectorySync.mockReset();
  audit.mockReset();
});

describe("enqueueInitialDirectorySync", () => {
  it("queues the sync and audits it like a manual one", async () => {
    enqueueDirectorySync.mockResolvedValue({ status: "queued", jobId: "job-1" });
    audit.mockResolvedValue(undefined);

    await enqueueInitialDirectorySync(db, tenantId, sourceId, {
      label: "entra:admin-consent",
      ip: "192.0.2.10",
    });

    expect(enqueueDirectorySync).toHaveBeenCalledWith(db, tenantId, sourceId);
    expect(audit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        tenantId,
        actor: "entra:admin-consent",
        actorUserId: null,
        action: "directory.sync.requested",
        target: sourceId,
        targetType: "source",
        ip: "192.0.2.10",
        details: { full: false, auto: true },
      }),
    );
  });

  it("passes the actor's user id through when given", async () => {
    enqueueDirectorySync.mockResolvedValue({ status: "queued", jobId: "job-1" });
    audit.mockResolvedValue(undefined);

    await enqueueInitialDirectorySync(db, tenantId, sourceId, {
      label: "admin@contoso.example",
      userId: "user-1",
      ip: null,
    });

    expect(audit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ actor: "admin@contoso.example", actorUserId: "user-1", ip: null }),
    );
  });

  it("is idempotent: a sync already queued or running is left alone", async () => {
    enqueueDirectorySync.mockResolvedValue({ status: "already_queued", jobId: "job-1" });
    audit.mockResolvedValue(undefined);

    await enqueueInitialDirectorySync(db, tenantId, sourceId, {
      label: "entra:admin-consent",
      ip: null,
    });

    expect(enqueueDirectorySync).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("never throws: a queueing failure is swallowed, the caller is not affected", async () => {
    enqueueDirectorySync.mockRejectedValue(new Error("queue not ready"));

    await expect(
      enqueueInitialDirectorySync(db, tenantId, sourceId, {
        label: "entra:admin-consent",
        ip: null,
      }),
    ).resolves.toBeUndefined();
    expect(audit).not.toHaveBeenCalled();
  });

  it("never throws when the audit write itself fails", async () => {
    enqueueDirectorySync.mockResolvedValue({ status: "queued", jobId: "job-1" });
    audit.mockRejectedValue(new Error("db unavailable"));

    await expect(
      enqueueInitialDirectorySync(db, tenantId, sourceId, {
        label: "entra:admin-consent",
        ip: null,
      }),
    ).resolves.toBeUndefined();
  });
});
