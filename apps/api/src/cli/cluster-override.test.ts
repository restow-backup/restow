import { describe, expect, it } from "vitest";
import { renderDatabaseOverride } from "./cluster-override.js";
import { parseCommand, UsageError } from "./main.js";

/**
 * The database exposure in docker-compose.override.yml (cluster-override.ts): added next to what
 * the operator and the mounter keep there, comments included; taken out completely again; and the
 * command line that install.sh runs.
 */

const MOUNTER = `# my own setting
services:
  worker:
    environment:
      LOG_LEVEL: debug # keep
    volumes:
      - restow-nfs-share-1a2b3c4d:/mnt/restow/share
x-restow-mounts:
  - name: share
`;

describe("the database override", () => {
  it("publishes PostgreSQL with TLS and keeps everything else", () => {
    const text = renderDatabaseOverride(MOUNTER, { bind: "10.0.0.5", port: 5432 });
    expect(text).toContain("# my own setting");
    expect(text).toContain("LOG_LEVEL: debug # keep");
    expect(text).toContain("restow-nfs-share-1a2b3c4d:/mnt/restow/share");
    expect(text).toContain("x-restow-cluster:");
    expect(text).toContain("- 10.0.0.5:5432:5432");
    expect(text).toContain("ssl=on");
    expect(text).toContain("hba_file=/etc/restow/postgres-tls/pg_hba.conf");
    expect(text).toContain("./postgres-tls:/etc/restow/postgres-tls:ro");
    expect(text).toContain("./postgres-tls/ca.crt:/etc/restow/postgres-tls/ca.crt:ro");
    // Again: the same file, nothing doubled.
    expect(renderDatabaseOverride(text, { bind: "10.0.0.5", port: 5432 })).toBe(text);
    const moved = renderDatabaseOverride(text, { bind: "10.0.0.6", port: 6432 });
    expect(moved).toContain("- 10.0.0.6:6432:5432");
    expect(moved).not.toContain("10.0.0.5");
  });

  it("takes all of it out again", () => {
    const exposed = renderDatabaseOverride(MOUNTER, { bind: "10.0.0.5", port: 5432 });
    const removed = renderDatabaseOverride(exposed, null);
    expect(removed).not.toContain("postgres");
    expect(removed).not.toContain("x-restow-cluster");
    expect(removed).toContain("restow-nfs-share-1a2b3c4d");
    expect(
      renderDatabaseOverride(renderDatabaseOverride("", { bind: "::1", port: 5432 }), null),
    ).toBe("");
  });

  it("refuses a postgres command or ports of the operator's own", () => {
    expect(() =>
      renderDatabaseOverride("services:\n  postgres:\n    ports: ['5432:5432']\n", {
        bind: "10.0.0.5",
        port: 5432,
      }),
    ).toThrow(/remove them by hand/);
  });

  it("parses the command install.sh runs", () => {
    expect(
      parseCommand([
        "cluster",
        "database-override",
        "--file",
        "/project/docker-compose.override.yml",
        "--bind",
        "10.0.0.5",
        "--port",
        "5432",
      ]),
    ).toEqual({
      kind: "cluster-override",
      file: "/project/docker-compose.override.yml",
      exposure: { bind: "10.0.0.5", port: 5432 },
    });
    expect(
      parseCommand(["cluster", "database-override", "--file", "/project/o.yml", "--remove"]),
    ).toEqual({ kind: "cluster-override", file: "/project/o.yml", exposure: null });
    for (const args of [
      ["cluster", "database-override", "--file", "relative.yml", "--bind", "10.0.0.5"],
      ["cluster", "database-override", "--file", "/project/o.yml", "--bind", "host.example"],
      ["cluster", "database-override", "--file", "/project/o.yml", "--remove", "--port", "1"],
      ["cluster", "expose"],
    ]) {
      expect(() => parseCommand(args), args.join(" ")).toThrow(UsageError);
    }
  });
});
