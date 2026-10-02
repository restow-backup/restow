// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type * as React from "react";
import { type Root, createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { registerWebExtension, resetWebExtensionsForTesting } from "@/lib/extensions";

import "../i18n";
import type { HealthState } from "../hooks";
import type { TenantDetail, TenantHealth, TenantItem, UsageOverview } from "../types";
import { HealthSummary, LastBackup, MailboxUsageText, TenantStatusBadge } from "./badges";
import { CustomerDataPanel } from "./customer-data-panel";
import { InstallationPanel } from "./installation-panel";
import { TenantTable } from "./tenant-table";

/**
 * Component tests rendered to static markup (no DOM needed). Router links
 * become plain anchors so components render outside a router. Assertions use
 * messages without ICU arguments: the Node test runtime cannot load the ICU
 * formatter the browser build uses.
 *
 * One block ("adding a contact to an empty tenant") mounts into a real DOM
 * instead: it drives the edit-contacts dialog through a click, so it needs
 * `CustomerDataPanel`'s mutation hooks to actually run, which static markup
 * cannot exercise.
 */

// React only batches and flushes effects synchronously inside `act` when it
// knows it is running under a test renderer (see tenant-wizard.test.tsx).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      className,
      children,
    }: { to: string; className?: string; children: React.ReactNode }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

// Only the "adding a contact" block below issues a request (PUT the replaced
// contact list); every static-markup test never opens a dialog, so it never
// touches this mock.
const apiFetchMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const usage: UsageOverview = {
  usedMailboxes: 12,
  mailboxesByTenant: { t1: 12 },
};

const health: TenantHealth = {
  readiness: "red",
  protectedObjects: 4,
  notReady: 1,
  lastBackupAt: "2026-09-22T01:00:00.000Z",
  lastCheckedAt: null,
};

function tenant(id: string, overrides: Partial<TenantItem> = {}): TenantItem {
  return {
    id,
    name: `Tenant ${id}`,
    slug: `tenant-${id}`,
    kind: "customer",
    status: "active",
    customerNumber: null,
    organizationId: null,
    mailboxCap: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function tenantDetail(overrides: Partial<TenantDetail> = {}): TenantDetail {
  return {
    ...tenant("t1"),
    memberCount: 0,
    pendingInvitations: 0,
    keyVersion: 1,
    customer: {
      customerNumber: null,
      vatId: null,
      addressLine1: null,
      addressLine2: null,
      postalCode: null,
      city: null,
      countryCode: null,
      language: null,
      timeZone: null,
    },
    contacts: [],
    notificationRecipients: [],
    ...overrides,
  };
}

describe("InstallationPanel", () => {
  afterEach(() => {
    resetWebExtensionsForTesting();
  });

  it("states mailboxes and tenants, and no edition, when another tenant may be created", () => {
    const html = render(
      <InstallationPanel
        tenantCount={3}
        creationAllowed
        usage={{ status: "success", data: usage }}
      />,
    );
    expect(html).toContain("12 mailboxes protected");
    expect(html).toContain("3 tenants");
    expect(html).not.toContain("This installation manages one tenant.");
    expect(html).not.toMatch(/edition|Community|Business|Service Provider|licen/i);
  });

  it("says neutrally that the installation manages one tenant when no further one may be created", () => {
    const html = render(
      <InstallationPanel
        tenantCount={1}
        creationAllowed={false}
        usage={{ status: "success", data: usage }}
      />,
    );
    expect(html).toContain("This installation manages one tenant.");
    expect(html).not.toMatch(/edition|Community|Business|Service Provider|licen/i);
    expect(html).not.toContain("href=");
  });

  it("lets an extension word the refusal instead (slot tenants.creationLocked)", () => {
    registerWebExtension({
      name: "tenants-test",
      slots: { "tenants.creationLocked": () => <p>Extension reason</p> },
    });
    const locked = render(
      <InstallationPanel
        tenantCount={1}
        creationAllowed={false}
        usage={{ status: "success", data: usage }}
      />,
    );
    expect(locked).toContain("Extension reason");
    expect(locked).not.toContain("This installation manages one tenant.");
    const open = render(
      <InstallationPanel
        tenantCount={1}
        creationAllowed
        usage={{ status: "success", data: usage }}
      />,
    );
    expect(open).not.toContain("Extension reason");
  });

  it("says when usage is unavailable and never warns about a mailbox limit", () => {
    expect(
      render(
        <InstallationPanel
          tenantCount={0}
          creationAllowed
          usage={{ status: "error", data: undefined }}
        />,
      ),
    ).toContain("Mailbox usage is currently unavailable.");
    const crowded = render(
      <InstallationPanel
        tenantCount={1}
        creationAllowed
        usage={{ status: "success", data: { ...usage, usedMailboxes: 5000 } }}
      />,
    );
    expect(crowded).toContain("5,000 mailboxes protected");
    expect(crowded).not.toMatch(/limit/i);
  });
});

describe("status displays", () => {
  it("shows every state of the readiness honestly", () => {
    expect(render(<HealthSummary state={{ status: "pending", data: undefined }} />)).toContain(
      'aria-busy="true"',
    );
    const failed = render(<HealthSummary state={{ status: "error", data: undefined }} />);
    expect(failed).toContain("Unavailable");
    expect(failed).toContain("The readiness of this tenant could not be read.");
    expect(render(<HealthSummary state={{ status: "success", data: health }} />)).toContain(
      "Not ready",
    );
    expect(
      render(
        <HealthSummary
          state={{
            status: "success",
            data: { ...health, readiness: null, protectedObjects: 0, notReady: 0 },
          }}
        />,
      ),
    ).toContain("No objects protected yet");
    expect(render(<HealthSummary state={undefined} deleting />)).toContain(
      "Not checked while the tenant is being deleted",
    );
  });

  it("shows the last backup as a time, or that there is none", () => {
    expect(render(<LastBackup state={{ status: "success", data: health }} />)).toContain(
      'dateTime="2026-09-22T01:00:00.000Z"',
    );
    expect(
      render(<LastBackup state={{ status: "success", data: { ...health, lastBackupAt: null } }} />),
    ).toContain("No backup yet");
  });

  it("says unknown instead of zero and flags a tenant over its cap", () => {
    expect(render(<MailboxUsageText usage={{ used: null, cap: 5, overCap: false }} />)).toContain(
      "Unknown",
    );
    expect(render(<MailboxUsageText usage={{ used: 7, cap: 5, overCap: true }} />)).toContain(
      "Above the agreed cap",
    );
    expect(render(<TenantStatusBadge status="suspended" />)).toContain("Suspended");
  });
});

describe("TenantTable", () => {
  const healthById = new Map<string, HealthState>([["t1", { status: "success", data: health }]]);

  it("links every tenant, marks the current one and keeps deleted ones out of reach", () => {
    const html = render(
      <TenantTable
        tenants={[tenant("t1"), tenant("t2", { status: "deleting" })]}
        health={healthById}
        usage={usage}
        activeTenantId="t1"
        onEnter={() => undefined}
        onDelete={() => undefined}
      />,
    );
    expect(html).toContain('href="/tenants/t1/overview"');
    expect(html).toContain('href="/tenants/t2/overview"');
    expect(html).toContain("Current");
    expect(html).toContain("Being deleted");
    expect(html).toContain("Not counted while the tenant is being deleted");
    // One enabled and one disabled "Switch to tenant" button.
    const switches = html.match(/<button[^>]*>(?:(?!<\/button>).)*Switch to tenant/g) ?? [];
    expect(switches).toHaveLength(2);
    expect(switches.filter((button) => button.includes(' disabled=""'))).toHaveLength(1);
  });

  it("marks the own organisation with a badge of its own and no customer with it", () => {
    const html = render(
      <TenantTable
        tenants={[tenant("own", { kind: "internal" }), tenant("t1")]}
        health={healthById}
        usage={usage}
        activeTenantId={null}
        onEnter={() => undefined}
      />,
    );
    // One badge, on the own organisation's row only.
    expect(html.match(/Own organisation/g)).toHaveLength(1);
    const [ownRow, customerRow] = html
      .split("<tr")
      .filter((row) => row.includes('href="/tenants/'));
    expect(ownRow).toContain("Own organisation");
    expect(customerRow).not.toContain("Own organisation");
  });
});

describe("CustomerDataPanel", () => {
  it("offers a call to action from the empty state for contacts", () => {
    const html = render(<CustomerDataPanel tenant={tenantDetail()} />);
    expect(html).toContain("No contact persons yet.");
    expect(html).toContain("Add contact");
  });

  it("hides the add actions when read-only (the tenant is being deleted)", () => {
    const html = render(<CustomerDataPanel tenant={tenantDetail()} readOnly />);
    expect(html).not.toContain("Add contact");
  });

  it("leaves the notification recipients to the Notifications section of the tenant page", () => {
    const html = render(<CustomerDataPanel tenant={tenantDetail()} />);
    expect(html).not.toContain("Open alerts");
  });
});

describe("CustomerDataPanel: adding a contact to an empty tenant (interactive)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function mount() {
    const queryClient = new QueryClient();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <CustomerDataPanel tenant={tenantDetail()} />
          </I18nextProvider>
        </QueryClientProvider>,
      );
    });
  }

  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      setInputValue(input, value);
      await flush();
    });
  }

  async function click(element: Element) {
    await act(async () => {
      (element as HTMLElement).click();
      await flush();
    });
  }

  // The dialog renders through a Radix portal straight onto `document.body`,
  // not inside `container` (the same reason tenant-wizard.test.tsx queries
  // `document.body` throughout): every lookup below does too, so it finds
  // both the panel's own buttons and the dialog's once it opens.
  function byText(text: string): HTMLElement {
    const match = [...document.body.querySelectorAll<HTMLElement>("button")].find(
      (element) => element.textContent?.trim() === text,
    );
    if (!match) {
      throw new Error(`expected a button with the text "${text}"`);
    }
    return match;
  }

  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    apiFetchMock.mockReset();
  });

  it("seeds the first row as primary, so 'Add contact' from the empty state saves without touching the radio", async () => {
    apiFetchMock.mockResolvedValue([
      { id: "c1", name: "Alice Admin", role: null, email: null, phone: null, isPrimary: true },
    ]);
    mount();

    await click(byText("Add contact"));
    // The dialog opened straight onto one already-primary row, not an empty list.
    expect(document.body.querySelector("#wizard-contact-0-name")).not.toBeNull();
    expect(document.body.querySelector('[aria-checked="true"]')).not.toBeNull();

    await type(
      document.body.querySelector("#wizard-contact-0-name") as HTMLInputElement,
      "Alice Admin",
    );
    await click(byText("Save changes"));

    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/contacts"),
      expect.objectContaining({
        method: "PUT",
        body: [
          {
            name: "Alice Admin",
            role: undefined,
            email: undefined,
            phone: undefined,
            isPrimary: true,
          },
        ],
      }),
    );
  });
});
