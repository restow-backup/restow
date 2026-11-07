import { describe, expect, it } from "vitest";
import { quoteSqlIdentifier, quoteSqlString, sqlLoginScript } from "./login-script.js";

describe("sqlLoginScript", () => {
  it("makes the login a sysadmin by default", () => {
    expect(sqlLoginScript({ variant: "sysadmin" })).toBe(
      [
        "IF SUSER_ID(N'NT SERVICE\\RestowAgent') IS NULL CREATE LOGIN [NT SERVICE\\RestowAgent] FROM WINDOWS;",
        "ALTER SERVER ROLE [sysadmin] ADD MEMBER [NT SERVICE\\RestowAgent];",
        "",
      ].join("\n"),
    );
  });

  it("grants the small variant per user database, with names escaped", () => {
    const script = sqlLoginScript({
      variant: "minimal",
      databases: ["Sales", "a]b'c", "master", "Sales"],
    });
    expect(script).toContain("ALTER SERVER ROLE [dbcreator] ADD MEMBER [NT SERVICE\\RestowAgent];");
    expect(script).toContain("GRANT VIEW SERVER STATE TO [NT SERVICE\\RestowAgent];");
    expect(script).toContain("USE [Sales];");
    expect(script).toContain("USE [a]]b'c];");
    expect(script).not.toContain("USE [master]");
    expect(script.match(/USE \[Sales\];/g)).toHaveLength(1);
    expect(script.match(/db_backupoperator/g)).toHaveLength(2);
  });

  it("quotes like QUOTENAME and N'' literals", () => {
    expect(quoteSqlIdentifier("x]];DROP")).toBe("[x]]]];DROP]");
    expect(quoteSqlString("it's")).toBe("N'it''s'");
  });
});
