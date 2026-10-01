import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { QrCode } from "@/components/qr-code";
import { i18n } from "@/i18n";
import { AuthenticatorSetup, BackupCodesPanel } from "./authenticator-setup";

/**
 * Rendered to static markup (no DOM needed): the first step of the enrolment,
 * the recovery code panel and the QR code. The later steps depend on server
 * answers and are covered through their pure parts (presenters, forms).
 */

function render(node: React.ReactNode): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const noop = () => undefined;

describe("AuthenticatorSetup", () => {
  it("starts by asking for the password", () => {
    const html = render(<AuthenticatorSetup mode="enroll" onComplete={noop} />);
    expect(html).toContain("Confirm with your password");
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain("Continue");
    // Mandatory enrolment: without onCancel there is no way around it.
    expect(html).not.toContain("Cancel");
  });

  it("warns before replacing the current authenticator", () => {
    const html = render(<AuthenticatorSetup mode="replace" onComplete={noop} onCancel={noop} />);
    expect(html).toContain("Your current authenticator stops working");
    expect(html).toContain("Cancel");
  });
});

describe("BackupCodesPanel", () => {
  it("lists every code and holds Done back until their safekeeping is confirmed", () => {
    const codes = ["abcde-12345", "fghij-67890", "klmno-13579"];
    const html = render(
      <BackupCodesPanel codes={codes} account="admin@example.com" issuer="Restow" onDone={noop} />,
    );
    for (const code of codes) {
      expect(html).toContain(code);
    }
    expect(html).toContain("I have stored the recovery codes somewhere safe.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Done<\/button>/);
  });
});

describe("QrCode", () => {
  it("draws the symbol as an accessible image, dark on white", () => {
    const html = render(<QrCode value="otpauth://totp/Restow:a%40b.c?secret=MZXW6" label="Key" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Key"');
    expect(html).toContain("fill-white");
    expect(html).toMatch(/<path d="M4 4h7v1h-7z/);
  });
});
