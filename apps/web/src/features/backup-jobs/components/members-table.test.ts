import { describe, expect, it } from "vitest";

import { memberDetail, memberStatusWord } from "./members-table";

/** Answers the key's translation from a small table, else the default, like i18next does. */
const words: Record<string, string> = {
  "endpoints:os.darwin": "macOS",
  "endpoints:status.revoked": "Gesperrt",
  "directory:status.excluded": "Ausgeschlossen",
};
const t = (key: string, options?: { defaultValue?: string }) =>
  words[key] ?? options?.defaultValue ?? key;

describe("a job member in words", () => {
  it("names a machine's operating system, never the raw code", () => {
    expect(memberDetail({ kind: "client", detail: "darwin" }, t)).toBe("macOS");
    // A mailbox's detail is its address, as it is.
    expect(memberDetail({ kind: "mailbox", detail: "ada@contoso.example" }, t)).toBe(
      "ada@contoso.example",
    );
  });

  it("says why a member is not backed up in words", () => {
    expect(memberStatusWord({ kind: "server", status: "revoked" }, t)).toBe("Gesperrt");
    expect(memberStatusWord({ kind: "mailbox", status: "excluded" }, t)).toBe("Ausgeschlossen");
  });
});
