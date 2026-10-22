import { describe, expect, it } from "vitest";

import { mailcowBccEntries, postfixBccMap, sieveRedirect, sieveString } from "./instructions";

describe("forwarding instructions", () => {
  const targets = [
    { login: "info@hoster.example", address: "archive+a@archive.example.test" },
    { login: "office.manager@hoster.example", address: "archive+b@archive.example.test" },
  ];

  it("aligns the Postfix map, one account per line", () => {
    expect(postfixBccMap(targets)).toBe(
      [
        "info@hoster.example            archive+a@archive.example.test",
        "office.manager@hoster.example  archive+b@archive.example.test",
      ].join("\n"),
    );
  });

  it("lists a sender and a recipient map per account for mailcow", () => {
    expect(mailcowBccEntries(targets.slice(0, 1))).toBe(
      [
        "sender     info@hoster.example  ->  archive+a@archive.example.test",
        "recipient  info@hoster.example  ->  archive+a@archive.example.test",
      ].join("\n"),
    );
  });

  it("quotes Sieve strings and keeps the mail with :copy", () => {
    expect(sieveString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(sieveRedirect("archive+a@archive.example.test")).toBe(
      'require ["copy"];\nredirect :copy "archive+a@archive.example.test";',
    );
  });
});
