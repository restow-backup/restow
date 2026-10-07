// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { type Mounted, mount } from "@/features/endpoints/dom-harness";
import { i18n } from "@/i18n";
import { setActiveTenantId } from "@/lib/tenant";

import "../i18n";
import type { SourceDto } from "../types";
import { ImapSourceDialog } from "./imap-source-dialog";

/**
 * The IMAP source dialog: a new source starts with the shared login, the
 * "one password per mailbox" mode points to the Directory, and Microsoft
 * hosts get a warning (without blocking the form).
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({
      to,
      search,
      className,
      children,
      onClick,
    }: {
      to: string;
      search?: Record<string, string>;
      className?: string;
      children: React.ReactNode;
      onClick?: () => void;
    }) => {
      const query = search ? `?${new URLSearchParams(search).toString()}` : "";
      return (
        <a href={`${String(to)}${query}`} className={className} onClick={onClick}>
          {children}
        </a>
      );
    },
  };
});

function storedSource(over: Partial<NonNullable<SourceDto["imap"]>> = {}): SourceDto {
  return {
    id: "0b6f3a1e-6a55-4f0e-9f35-6c1c1f6f1a11",
    tenantId: "t-1",
    kind: "imap",
    name: "Hoster",
    status: "active",
    errorMessage: null,
    failure: null,
    lastSyncAt: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    m365: null,
    imap: {
      host: "imap.example.com",
      port: 993,
      security: "tls",
      username: "backup@example.com",
      hasPassword: false,
      authKind: "password",
      lastProbe: null,
      imapAuthMode: "per_mailbox",
      masterUser: null,
      ...over,
    },
  };
}

let view: Mounted;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  setActiveTenantId("t-1");
  view = mount();
});
afterEach(() => {
  view.unmount();
  setActiveTenantId(null);
});

async function open(source?: SourceDto) {
  await view.render(<ImapSourceDialog open onOpenChange={() => {}} source={source} />);
}

const manage = () => view.maybeByText<HTMLAnchorElement>("a", "Manage mailboxes and passwords");
const warning = () => document.body.querySelector('[data-testid="imap-microsoft-warning"]');
const hostInput = () =>
  document.body.querySelector<HTMLInputElement>("#imap-host") as HTMLInputElement;

describe("ImapSourceDialog", () => {
  it("starts a new source with the shared login and shows the password field", async () => {
    await open();
    expect(document.body.querySelector("#imap-auth-mode")?.textContent).toContain("Shared login");
    expect(document.body.querySelector("#imap-password")).not.toBeNull();
    expect(manage()).toBeNull();
  });

  it("keeps the stored mode of an existing source", async () => {
    await open(storedSource({ imapAuthMode: "master_user" }));
    expect(document.body.querySelector("#imap-auth-mode")?.textContent).toContain("Master user");
  });

  it("per mailbox: explains and links to the Directory sources tab", async () => {
    await open(storedSource());
    expect(document.body.querySelector("#imap-password")).toBeNull();
    expect(view.text()).toContain("This source has no password of its own");
    const link = manage();
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/tenants/t-1/protection?tab=sources");
  });

  it("warns for Microsoft hosts in any case and links to the Microsoft 365 tab", async () => {
    await open();
    expect(warning()).toBeNull();
    await view.type(hostInput(), "Outlook.Office365.com");
    expect(warning()).not.toBeNull();
    expect(warning()?.textContent).toContain("OAuth2");
    expect(warning()?.textContent).toContain("not supported yet");
    expect(warning()?.querySelector("a")?.getAttribute("href")).toBe("/tenants/t-1/connections");
    // saving stays possible
    const submit = document.body.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit?.disabled).toBe(false);
  });

  it.each(["outlook.office.com", "imap-mail.outlook.com"])("warns for %s", async (host) => {
    await open();
    await view.type(hostInput(), host);
    expect(warning()).not.toBeNull();
  });

  it("does not warn for other hosts", async () => {
    await open();
    await view.type(hostInput(), "imap.example.com");
    expect(warning()).toBeNull();
  });

  it("warns for a Microsoft host in per-mailbox mode too", async () => {
    await open(storedSource({ host: "outlook.office365.com" }));
    expect(warning()).not.toBeNull();
  });
});
