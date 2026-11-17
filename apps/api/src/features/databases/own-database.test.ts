import { describe, expect, it } from "vitest";
import { databaseUrlTargets, OwnDatabaseUnknownError } from "./own-database.js";

const resolve = async (host: string) => {
  if (host === "postgres") return ["172.18.0.3"];
  if (host === "db.internal.test") return ["10.0.0.7", "fd00::7"];
  throw new Error("ENOTFOUND");
};

describe("where Restow's own database listens (docs/DATABASES.md 4.2) [DB-003]", () => {
  it("reads hosts and ports of the URL and of its parameters", async () => {
    expect(await databaseUrlTargets("postgres://u:p@postgres:5433/restow", resolve)).toEqual([
      { address: "172.18.0.3", port: 5433 },
    ]);
    expect(await databaseUrlTargets("postgresql://u@10.1.2.3/restow", resolve)).toEqual([
      { address: "10.1.2.3", port: 5432 },
    ]);
    expect(
      await databaseUrlTargets(
        "postgres://u@ignored/restow?host=db.internal.test,10.9.9.9&port=6432,6433",
        resolve,
      ),
    ).toEqual([
      { address: "10.0.0.7", port: 6432 },
      { address: "fd00::7", port: 6432 },
      { address: "10.9.9.9", port: 6433 },
    ]);
    expect(await databaseUrlTargets("postgres://u@[::1]:5434,postgres/restow", resolve)).toEqual([
      { address: "::1", port: 5434 },
      { address: "172.18.0.3", port: 5432 },
    ]);
  });

  it("takes a Unix socket (or no host) for the database on this machine", async () => {
    for (const url of [
      "postgres://u@/restow?host=/var/run/postgresql",
      "postgres:///restow",
      "postgres://u@%2Fvar%2Frun%2Fpostgresql/restow",
    ]) {
      expect(await databaseUrlTargets(url, resolve), url).toEqual([
        { address: "127.0.0.1", port: 5432 },
        { address: "::1", port: 5432 },
      ]);
    }
  });

  it("fails instead of returning nothing when it cannot tell", async () => {
    for (const url of ["", "not a url", "mysql://db/x", "postgres://u@nowhere.test/restow"]) {
      await expect(databaseUrlTargets(url, resolve), url).rejects.toBeInstanceOf(
        OwnDatabaseUnknownError,
      );
    }
  });
});
