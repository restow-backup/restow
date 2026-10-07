import { describe, expect, it } from "vitest";

import type { Config } from "../../config.js";
import { environmentMailConfigured } from "./service.js";

const base = (overrides: Partial<Config>): Config =>
  ({
    mailTransport: undefined,
    graphMailSender: undefined,
    smtp: {
      host: undefined,
      port: undefined,
      secure: false,
      username: undefined,
      password: undefined,
      from: undefined,
    },
    ...overrides,
  }) as Config;

describe("notification mail from the environment", () => {
  it("is off without a transport in the environment", () => {
    expect(environmentMailConfigured(base({}))).toBe(false);
  });

  it("takes SMTP with a host and a sender, also without MAIL_TRANSPORT", () => {
    const smtp = {
      host: "mail.example.com",
      port: 587,
      secure: false,
      username: undefined,
      password: undefined,
      from: "backup@example.com",
    };
    expect(environmentMailConfigured(base({ smtp }))).toBe(true);
    expect(environmentMailConfigured(base({ mailTransport: "smtp", smtp }))).toBe(true);
    expect(environmentMailConfigured(base({ smtp: { ...smtp, from: undefined } }))).toBe(false);
  });

  it("takes Graph with a sender mailbox", () => {
    expect(
      environmentMailConfigured(
        base({ mailTransport: "graph", graphMailSender: "alerts@contoso.example" }),
      ),
    ).toBe(true);
    expect(environmentMailConfigured(base({ mailTransport: "graph" }))).toBe(false);
  });
});
