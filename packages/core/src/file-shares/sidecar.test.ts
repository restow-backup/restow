import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type SidecarEntry, readSidecar, readSidecarLines } from "./sidecar.js";

/** The golden file restow-share's writer produces (agent/internal/share/sidecar_test.go). */
const golden = readFileSync(
  fileURLToPath(
    new URL("../../../../agent/internal/share/testdata/sidecar/v1-basic.jsonl", import.meta.url),
  ),
  "utf8",
);

describe("permissions sidecar reader (4.6)", () => {
  it("reads the Go writer's golden file", async () => {
    const entries: SidecarEntry[] = [];
    const errors: string[] = [];
    const summary = await readSidecar(gzipSync(Buffer.from(golden)), {
      onEntry: (entry) => entries.push(entry),
      onError: (path, errno) => errors.push(`${path}:${errno}`),
    });
    expect(summary).toMatchObject({
      header: { protocol: "smb", xattr: "system.cifs_ntsd_full", v: 1 },
      entries: 6,
      descriptors: 3,
      errors: 1,
      complete: true,
      trailer: { entries: 6, descriptors: 3, errors: 1 },
      newerVersion: false,
    });
    expect(entries[0]).toEqual({
      path: "",
      pathBytes: null,
      descriptorId: "fceb84ea54c639f5",
      dosAttributes: 16,
      creationTime: null,
    });
    expect(entries.find((e) => e.pathBytes)?.path).toBeNull();
    expect(entries.at(-1)?.path).toBe("Ünïcode/ok");
    expect(errors).toEqual(["HR/locked:EACCES"]);
  });

  it("says a sidecar without trailer is incomplete and ignores unknown types", async () => {
    const lines = golden
      .trim()
      .split("\n")
      .filter((line) => !line.includes('"t":"z"'));
    lines.push('{"t":"q","future":true}');
    const summary = await readSidecarLines(lines);
    expect(summary.complete).toBe(false);
    expect(summary.entries).toBe(6);
  });

  it("reads only the header of a newer version", async () => {
    const summary = await readSidecarLines([
      '{"t":"h","format":"restow-share-permissions","v":2,"protocol":"nfs","xattr":"system.nfs4_acl"}',
      '{"t":"e","p":"x"}',
    ]);
    expect(summary).toMatchObject({ newerVersion: true, entries: 0 });
  });

  it("refuses something that is not a sidecar", async () => {
    await expect(readSidecarLines(['{"t":"e","p":""}'])).rejects.toThrow(/no header/);
    await expect(readSidecarLines([])).rejects.toThrow(/empty/);
    await expect(readSidecarLines(["not json"])).rejects.toThrow(/not JSON/);
  });
});
