/**
 * Which recovery ISO an installation offers (docs/BAREMETAL.md 8.5, 9.2): only one the newest
 * signed agent release lists under `recovery/` in its checksums counts as verified. A release
 * without that line (every release before the ISO ships) leaves the code dialog and the wizard
 * hidden and refuses to issue codes.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { recoveryIsoFileName, recoveryIsoState } from "./recovery-iso.js";

const roots: string[] = [];

async function root(releases: { version: string; iso: boolean; signed: boolean }[]) {
  const dir = await mkdtemp(join(tmpdir(), "restow-recovery-iso-"));
  roots.push(dir);
  for (const release of releases) {
    await mkdir(join(dir, release.version), { recursive: true });
    const lines = [`${"a".repeat(64)}  linux-amd64/restow-agent`];
    if (release.iso) {
      lines.push(`${"C".repeat(64)}  recovery/${recoveryIsoFileName(release.version)}`);
    }
    await writeFile(join(dir, release.version, "SHA256SUMS"), `${lines.join("\n")}\n`);
    if (release.signed) {
      await writeFile(join(dir, release.version, "SHA256SUMS.sig"), "sig\n");
    }
  }
  return dir;
}

afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe("recoveryIsoState", () => {
  it("is verified when the newest signed release lists its ISO", async () => {
    const state = await recoveryIsoState(
      await root([{ version: "0.5.0", iso: true, signed: true }]),
      "https://restow.firma.de/",
    );
    expect(state).toMatchObject({
      version: "0.5.0",
      fileName: "restow-recovery_0.5.0_amd64.iso",
      url: "https://restow.firma.de/install/recovery/0.5.0/restow-recovery_0.5.0_amd64.iso",
      sha256: "c".repeat(64),
      verified: true,
    });
    expect(state.commands.linux.join("\n")).toContain("sha256sum -c");
    expect(state.commands.windows[0]).toContain("Get-FileHash");
  });

  it("is not verified for a release without the ISO, an unsigned one, or none", async () => {
    const plain = await recoveryIsoState(
      await root([{ version: "0.5.0", iso: false, signed: true }]),
    );
    expect(plain).toMatchObject({ version: null, url: null, sha256: null, verified: false });
    expect(plain.commands).toEqual({ linux: [], macos: [], windows: [] });
    // An unsigned newer release is skipped; the newest signed one decides, and it has no ISO.
    expect(
      (
        await recoveryIsoState(
          await root([
            { version: "0.5.1", iso: true, signed: false },
            { version: "0.5.0", iso: false, signed: true },
            { version: "0.4.9", iso: true, signed: true },
          ]),
        )
      ).verified,
    ).toBe(false);
    expect((await recoveryIsoState(await root([]))).verified).toBe(false);
  });
});
