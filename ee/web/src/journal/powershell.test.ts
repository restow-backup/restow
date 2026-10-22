import { describe, expect, it } from "vitest";

import { journalPowerShell, ndrProblem, psQuote, reportArrivedSince } from "./powershell";

/** The generated Exchange Online commands: exact text, quoting, and the NDR address check. */

const INPUT = {
  address: "journal+abcdefghijklmnopqrstuvwxyz234567@archive.example.test",
  journalHost: "archive.example.test",
  ndrAddress: "journal-ndr@contoso.example",
  appName: "Restow",
};

describe("journalPowerShell", () => {
  it("writes the connector, the NDR mailbox and the journal rule", () => {
    expect(journalPowerShell(INPUT)).toMatchInlineSnapshot(`
      "Connect-ExchangeOnline
      New-OutboundConnector -Name 'Restow Journal' -ConnectorType Partner -RecipientDomains 'archive.example.test' -SmartHosts 'archive.example.test' -UseMXRecord $false -TlsSettings DomainValidation -TlsDomain 'archive.example.test'
      Set-TransportConfig -JournalingReportNdrTo 'journal-ndr@contoso.example'
      New-JournalRule -Name 'Restow' -JournalEmailAddress 'journal+abcdefghijklmnopqrstuvwxyz234567@archive.example.test' -Scope Global -Enabled $true"
    `);
  });

  it("names the connector and the rule after the installation's product name", () => {
    const script = journalPowerShell({ ...INPUT, appName: "Backup Pro" });
    expect(script).toContain("-Name 'Backup Pro Journal'");
    expect(script).toContain("New-JournalRule -Name 'Backup Pro'");
  });

  it("doubles every kind of single quote, so a value cannot end its string", () => {
    expect(psQuote("o'brien@contoso.example")).toBe("'o''brien@contoso.example'");
    expect(psQuote("a\u2019b")).toBe("'a\u2019\u2019b'");
    expect(psQuote("\u2018\u201A\u201B")).toBe("'\u2018\u2018\u201A\u201A\u201B\u201B'");
    // Nothing else is special inside single quotes: no variables, no escapes.
    expect(psQuote("$env:x `n")).toBe("'$env:x `n'");
    const script = journalPowerShell({ ...INPUT, appName: "It's'; Remove-Item C:\\ -Recurse; '" });
    expect(script).toContain("-Name 'It''s''; Remove-Item C:\\ -Recurse; '''");
  });
});

describe("ndrProblem", () => {
  const journal = { address: INPUT.address, hostname: INPUT.journalHost };

  it("accepts a real mailbox elsewhere", () => {
    expect(ndrProblem(" journal-ndr@contoso.example ", journal)).toBeNull();
  });

  it("refuses an empty, a malformed or a quoting address", () => {
    expect(ndrProblem("", journal)).toBe("empty");
    expect(ndrProblem("journal-ndr", journal)).toBe("invalid");
    expect(ndrProblem("a b@contoso.example", journal)).toBe("invalid");
    expect(ndrProblem("x'@contoso.example", journal)).toBe("invalid");
  });

  it("refuses the journal address and the journal host", () => {
    expect(ndrProblem(INPUT.address.toUpperCase(), journal)).toBe("journal_address");
    expect(ndrProblem("someone@archive.example.test", journal)).toBe("journal_host");
  });
});

describe("reportArrivedSince", () => {
  it("counts a report at or after the start of the wait", () => {
    const since = Date.parse("2026-10-22T10:00:00Z");
    expect(reportArrivedSince(null, since)).toBe(false);
    expect(reportArrivedSince("2026-10-22T09:59:59Z", since)).toBe(false);
    expect(reportArrivedSince("2026-10-22T10:00:00Z", since)).toBe(true);
  });
});
