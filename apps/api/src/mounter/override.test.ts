import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  OverrideError,
  conflictsOf,
  managedMountsOf,
  nfsMountOptions,
  renderOverride,
  settingsHash,
  volumeKeyOf,
} from "./override.js";
import { type MountSpec, mountSpecSchema } from "./protocol.js";

function nfs(name: string, extra: Partial<Record<string, unknown>> = {}): MountSpec {
  return mountSpecSchema.parse({
    protocol: "nfs",
    name,
    server: "nas.example.lan",
    export: "/volume1/backup",
    nfsVersion: "4.1",
    readOnly: false,
    ...extra,
  });
}

const USER_OVERRIDE = `# My own settings
services:
  api:
    environment:
      LOG_LEVEL: debug # keep this comment
    volumes:
      - ./certs:/certs:ro
  caddy:
    ports:
      - "8443:443"
volumes:
  my-volume: {}
`;

describe("volume names and options", () => {
  it("names the volume after the share and a hash of its settings", () => {
    const spec = nfs("nas");
    expect(volumeKeyOf(spec)).toMatch(/^restow-nfs-nas-[0-9a-f]{8}$/);
    expect(settingsHash(spec)).toBe(settingsHash(nfs("other")));
    expect(volumeKeyOf(nfs("nas", { readOnly: true }))).not.toBe(volumeKeyOf(spec));
    expect(volumeKeyOf(nfs("nas", { nfsVersion: "3" }))).not.toBe(volumeKeyOf(spec));
    expect(volumeKeyOf(nfs("nas", { export: "/other" }))).not.toBe(volumeKeyOf(spec));
  });

  it("mounts hard for the services and soft for the test", () => {
    expect(nfsMountOptions(nfs("nas"), "mount")).toBe(
      "addr=nas.example.lan,nfsvers=4.1,hard,noatime",
    );
    expect(nfsMountOptions(nfs("nas", { readOnly: true }), "mount")).toBe(
      "addr=nas.example.lan,nfsvers=4.1,hard,noatime,ro",
    );
    expect(nfsMountOptions(nfs("nas"), "probe")).toBe(
      "addr=nas.example.lan,nfsvers=4.1,soft,timeo=50,retrans=1",
    );
  });
});

describe("renderOverride", () => {
  it("creates a file with the share for the api and the worker", () => {
    const spec = nfs("nas");
    const text = renderOverride(null, [spec]) as string;
    const parsed = parse(text);
    const key = volumeKeyOf(spec);
    expect(parsed.volumes[key]).toEqual({
      driver: "local",
      driver_opts: {
        type: "nfs",
        o: "addr=nas.example.lan,nfsvers=4.1,hard,noatime",
        device: ":/volume1/backup",
      },
      labels: { "com.restow.mounter.mount": "nas" },
    });
    expect(parsed.services.api.volumes).toEqual([`${key}:/mnt/restow/nas`]);
    expect(parsed.services.worker.volumes).toEqual([`${key}:/mnt/restow/nas`]);
    expect(parsed["x-restow-mounts"]).toEqual([
      {
        protocol: "nfs",
        name: "nas",
        server: "nas.example.lan",
        export: "/volume1/backup",
        nfsVersion: "4.1",
        readOnly: false,
        volume: key,
      },
    ]);
    expect(managedMountsOf(text)).toEqual([spec]);
  });

  it("marks a read-only share read-only in the services as well", () => {
    const spec = nfs("archive", { readOnly: true });
    const parsed = parse(renderOverride(null, [spec]) as string);
    expect(parsed.services.api.volumes).toEqual([`${volumeKeyOf(spec)}:/mnt/restow/archive:ro`]);
  });

  it("keeps the operator's own settings and comments", () => {
    const text = renderOverride(USER_OVERRIDE, [nfs("nas")]) as string;
    expect(text).toContain("# My own settings");
    expect(text).toContain("# keep this comment");
    const parsed = parse(text);
    expect(parsed.services.api.environment).toEqual({ LOG_LEVEL: "debug" });
    expect(parsed.services.api.volumes[0]).toBe("./certs:/certs:ro");
    expect(parsed.services.api.volumes).toHaveLength(2);
    expect(parsed.services.caddy).toEqual({ ports: ["8443:443"] });
    expect(parsed.volumes["my-volume"]).toEqual({});
  });

  it("is idempotent", () => {
    const mounts = [nfs("b"), nfs("a", { server: "10.0.0.5", nfsVersion: "3" })];
    const once = renderOverride(USER_OVERRIDE, mounts) as string;
    expect(renderOverride(once, mounts)).toBe(once);
    expect(renderOverride(once, [...mounts].reverse())).toBe(once);
  });

  it("removes only the managed entries", () => {
    const withShares = renderOverride(USER_OVERRIDE, [nfs("nas"), nfs("two")]) as string;
    const back = renderOverride(withShares, []) as string;
    expect(parse(back)).toEqual(parse(USER_OVERRIDE));
    expect(back).toContain("# keep this comment");
    expect(back).not.toContain("restow-nfs-");
    expect(back).not.toContain("x-restow-mounts");
  });

  it("removes one share and keeps the other", () => {
    const a = nfs("a");
    const b = nfs("b");
    const both = renderOverride(null, [a, b]) as string;
    const parsed = parse(renderOverride(both, [b]) as string);
    expect(Object.keys(parsed.volumes)).toEqual([volumeKeyOf(b)]);
    expect(parsed.services.api.volumes).toEqual([`${volumeKeyOf(b)}:/mnt/restow/b`]);
    expect(parsed["x-restow-mounts"].map((entry: { name: string }) => entry.name)).toEqual(["b"]);
  });

  it("replaces a share whose settings changed with a new volume", () => {
    const before = nfs("nas");
    const after = nfs("nas", { nfsVersion: "4.2" });
    const parsed = parse(renderOverride(renderOverride(null, [before]), [after]) as string);
    expect(Object.keys(parsed.volumes)).toEqual([volumeKeyOf(after)]);
  });

  it("returns null when nothing would be left in a file it created", () => {
    expect(renderOverride(null, [])).toBeNull();
    expect(renderOverride(renderOverride(null, [nfs("nas")]), [])).toBeNull();
  });

  it("drops managed entries someone left in the long syntax as well", () => {
    const text = `services:
  worker:
    volumes:
      - type: volume
        source: restow-nfs-old-12345678
        target: /mnt/restow/old
      - type: bind
        source: ./x
        target: /x
`;
    const parsed = parse(renderOverride(text, []) as string);
    expect(parsed.services.worker.volumes).toEqual([{ type: "bind", source: "./x", target: "/x" }]);
  });

  it("refuses a file that is not a mapping or not valid YAML", () => {
    expect(() => renderOverride("- a\n- b\n", [])).toThrow(OverrideError);
    expect(() => renderOverride("services: [\n", [])).toThrow(OverrideError);
    expect(() => renderOverride("services: 1\n", [nfs("nas")])).toThrow(OverrideError);
  });

  it("refuses a managed list that was edited into something invalid", () => {
    const text = `x-restow-mounts:\n  - protocol: nfs\n    name: "Bad Name"\n    server: x\n    export: /e\n`;
    expect(() => managedMountsOf(text)).toThrow(OverrideError);
  });

  it("handles an empty file and a file with only comments", () => {
    expect(managedMountsOf("")).toEqual([]);
    expect(managedMountsOf("# nothing\n")).toEqual([]);
    const text = renderOverride("# nothing yet\n", [nfs("nas")]) as string;
    expect(text).toContain("# nothing yet");
    expect(managedMountsOf(text)).toHaveLength(1);
  });
});

describe("conflictsOf", () => {
  it("finds the operator's own volume at the share's path", () => {
    const text = "services:\n  api:\n    volumes:\n      - /srv/nas:/mnt/restow/nas\n";
    expect(conflictsOf(text, nfs("nas"))).toEqual(["services.api.volumes: /mnt/restow/nas"]);
    expect(conflictsOf(text, nfs("other"))).toEqual([]);
  });

  it("ignores the managed entries", () => {
    const text = renderOverride(null, [nfs("nas")]);
    expect(conflictsOf(text, nfs("nas", { nfsVersion: "3" }))).toEqual([]);
  });
});
