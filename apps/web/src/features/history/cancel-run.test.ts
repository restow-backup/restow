import { beforeEach, describe, expect, it, vi } from "vitest";

/** "Cancel" in the run drawer reaches the run where it runs (0.4.2). */

const cancelJob = vi.fn(async () => ({}));
const cancelEndpointBackup = vi.fn(async () => ({ withdrawn: 0, stopping: 1 }));
const cancelShareRun = vi.fn(async () => ({}));
vi.mock("@/features/jobs/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/jobs/api")>()),
  cancelJob: (...args: unknown[]) => cancelJob(...(args as [])),
}));
vi.mock("@/features/endpoints/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/endpoints/api")>()),
  cancelEndpointBackup: (...args: unknown[]) => cancelEndpointBackup(...(args as [])),
}));
vi.mock("@/features/file-shares/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/file-shares/api")>()),
  cancelRun: (...args: unknown[]) => cancelShareRun(...(args as [])),
}));

const { cancelRunOf } = await import("./hooks");

beforeEach(() => vi.clearAllMocks());

describe("cancelRunOf", () => {
  it("cancels a mail run as a job", async () => {
    await cancelRunOf({ id: "j-1", source: "mail", subject: null });
    await cancelRunOf("j-2");
    expect(cancelJob.mock.calls).toEqual([["j-1"], ["j-2"]]);
  });

  it("asks a machine's agent to stop its backup", async () => {
    await cancelRunOf({
      id: "r-1",
      source: "endpoint",
      subject: { kind: "server", id: "e-1", name: "web", detail: "linux" },
    });
    expect(cancelEndpointBackup).toHaveBeenCalledWith("e-1");
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it("cancels a share's run through the share", async () => {
    await cancelRunOf({
      id: "s-run",
      source: "file_share",
      subject: { kind: "file_share", id: "share-1", name: "data", detail: "\\\\nas\\data" },
    });
    expect(cancelShareRun).toHaveBeenCalledWith("share-1", "s-run");
  });
});
