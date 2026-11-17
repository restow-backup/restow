import { describe, expect, it } from "vitest";
import { databaseUrlTargets, OwnDatabaseUnknownError } from "./own-database.js";

const resolve = async (host: string) => {
  if (host === "postgres") return ["172.18.0.3"];
  if (host === "db.internal.test") return ["10.0.0.7"];
  throw new Error("ENOTFOUND");
};

describe("Restow's own database from its connection string and environment [DB-003]", () => {
  it("takes PGHOST and PGPORT where the URL leaves them out, as node-postgres does", async () => {
    expect(
      await databaseUrlTargets("postgres://restow_app:pw@/restow", resolve, {
        PGHOST: "postgres",
        PGPORT: "6543",
      }),
    ).toEqual([{ address: "172.18.0.3", port: 6543 }]);
    expect(
      await databaseUrlTargets("postgres://u@db.internal.test/restow", resolve, {
        PGHOST: "postgres",
        PGPORT: "6543",
      }),
    ).toEqual([{ address: "10.0.0.7", port: 6543 }]);
    // What the URL names wins.
    expect(
      await databaseUrlTargets("postgres://u@10.1.1.1:5433/restow", resolve, {
        PGHOST: "postgres",
        PGPORT: "6543",
      }),
    ).toEqual([{ address: "10.1.1.1", port: 5433 }]);
  });

  it("adds hostaddr and PGHOSTADDR, the address the client really connects to", async () => {
    expect(
      await databaseUrlTargets("postgres://u@postgres/restow?hostaddr=10.2.2.2", resolve, {}),
    ).toEqual([
      { address: "10.2.2.2", port: 5432 },
      { address: "172.18.0.3", port: 5432 },
    ]);
    expect(
      await databaseUrlTargets("postgres://u@postgres/restow", resolve, { PGHOSTADDR: "10.3.3.3" }),
    ).toEqual([
      { address: "10.3.3.3", port: 5432 },
      { address: "172.18.0.3", port: 5432 },
    ]);
    await expect(
      databaseUrlTargets("postgres://u@postgres/restow?hostaddr=postgres", resolve, {}),
    ).rejects.toBeInstanceOf(OwnDatabaseUnknownError);
  });

  it("reads keyword/value connection strings", async () => {
    expect(
      await databaseUrlTargets(
        "host=db.internal.test port=6432 dbname=restow user=restow_app password='a b\\'c'",
        resolve,
        {},
      ),
    ).toEqual([{ address: "10.0.0.7", port: 6432 }]);
    expect(await databaseUrlTargets("dbname=restow user=restow_app", resolve, {})).toEqual([
      { address: "127.0.0.1", port: 5432 },
      { address: "::1", port: 5432 },
    ]);
    expect(
      await databaseUrlTargets("dbname=restow", resolve, { PGHOST: "postgres", PGPORT: "5440" }),
    ).toEqual([{ address: "172.18.0.3", port: 5440 }]);
    for (const text of ["host='unterminated", "not a url", "mysql://db/x"]) {
      await expect(databaseUrlTargets(text, resolve, {}), text).rejects.toBeInstanceOf(
        OwnDatabaseUnknownError,
      );
    }
  });
});
