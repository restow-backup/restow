import { describe, expect, it } from "vitest";
import { mountErrorCode } from "./ops.js";

describe("mountErrorCode", () => {
  it("names a missing export path, from mount.nfs and from Docker's local volume driver", () => {
    expect(
      mountErrorCode(
        "mount.nfs: mounting 192.168.1.10:/backup failed, reason given by server: No such file or directory",
      ),
    ).toBe("probe.export_not_found");
    expect(
      mountErrorCode(
        "error while mounting volume '/var/lib/docker/volumes/restow-mounter-probe-1/_data': failed to mount local volume: mount :/backup:/var/lib/docker/volumes/restow-mounter-probe-1/_data, data: addr=192.168.1.10,nfsvers=4.1: no such file or directory",
      ),
    ).toBe("probe.export_not_found");
  });

  it("keeps the other mount failures apart", () => {
    expect(
      mountErrorCode(
        "failed to mount local volume: mount :/backup:/x, data: addr=192.168.1.10: connection timed out",
      ),
    ).toBe("probe.timeout");
    expect(
      mountErrorCode("failed to mount local volume: mount :/backup:/x: permission denied"),
    ).toBe("probe.mount_failed");
    // ENOENT that is not about the NFS mount is not called a missing export.
    expect(mountErrorCode('exec: "sh": no such file or directory')).toBe("probe.mount_failed");
  });
});
