// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type * as React from "react";
import { type Root, createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { type UseFormReturn, useForm } from "react-hook-form";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";
import { zodResolver } from "@/lib/form";
import { type SessionContextValue, StaticSessionProvider } from "@/lib/session";

import "../../i18n";
import {
  type TenantWizardValues,
  WIZARD_STEPS,
  emptyAdmin,
  emptyContact,
  emptyRecipient,
  emptyTenantWizardForm,
  tenantWizardSchema,
} from "../../forms";
import { AdminsStep } from "./step-admins";
import { ContactsStep } from "./step-contacts";
import { NotificationsStep } from "./step-notifications";
import { OrganisationStep } from "./step-organisation";
import { ReviewStep } from "./step-review";
import { SourceStep } from "./step-source";
import { TenantWizard, WizardStepIndicator } from "./tenant-wizard";

/**
 * Two kinds of tests share this file (the pragma at the top switches the
 * whole file to a real DOM, `page-context.test.tsx` does the same; a DOM
 * present does not stop `renderToStaticMarkup` from working):
 *
 * - Static-markup render tests (no interaction), the same convention as
 *   components.test.tsx: they exercise a step component directly through a
 *   small `useForm` harness and assert its wiring (aria-invalid,
 *   aria-describedby, disabled affordances, i18n).
 * - "TenantWizard (interactive)" further down mounts the real component —
 *   Sheet, step indicator, keyboard handling and all — and drives it with
 *   real DOM events, because step validation gating "Next", Enter/Tab
 *   behaviour and the submit error path are only real once the whole thing
 *   is wired together, not proven by any single step in isolation.
 */

// React only batches and flushes effects synchronously inside `act` when it
// knows it is running under a test renderer; nothing else sets this flag for
// us in this workspace (no React Testing Library, no global test setup
// file), and the interactive tests below need it for effects and events to
// settle inside `act`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// No router is mounted for the interactive tests below (they exercise the
// wizard's own step and submit logic, not where it navigates to); `Link`
// becomes a plain anchor and `useNavigate` a spy, the same substitution
// components.test.tsx makes for `Link`.
const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children?: React.ReactNode;
      className?: string;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

// The wizard's only network call in these tests is POST /tenants (creating
// the tenant); each test configures what it resolves or rejects with.
const apiFetchMock = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

function Harness({
  defaultValues,
  render,
}: {
  defaultValues: TenantWizardValues;
  render: (form: UseFormReturn<TenantWizardValues>) => React.ReactNode;
}) {
  const form = useForm<TenantWizardValues>({
    resolver: zodResolver(tenantWizardSchema),
    defaultValues,
  });
  return <>{render(form)}</>;
}

function renderStep(
  render: (form: UseFormReturn<TenantWizardValues>) => React.ReactNode,
  defaultValues: TenantWizardValues = emptyTenantWizardForm("en"),
): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <Harness defaultValues={defaultValues} render={render} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("WizardStepIndicator", () => {
  it("marks the current step, locks steps not reached yet, and names every step", () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <WizardStepIndicator current={1} maxReached={2} onSelect={() => undefined} />
      </I18nextProvider>,
    );
    expect(html).toContain('aria-current="step"');
    // Step 4 (index 3) has not been reached: its button is disabled.
    expect(html).toMatch(/disabled=""[^>]*>\s*<span[^>]*>4<\/span>\s*Administrators/);
    for (const step of WIZARD_STEPS) {
      expect(html).toContain(
        {
          organisation: "Organisation",
          contacts: "Contacts",
          notifications: "Notifications",
          admins: "Administrators",
          source: "Source",
          review: "Review",
        }[step],
      );
    }
  });

  it("names every step in German too", async () => {
    await i18n.changeLanguage("de");
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <WizardStepIndicator current={0} maxReached={0} onSelect={() => undefined} />
      </I18nextProvider>,
    );
    expect(html).toContain("Organisation");
    expect(html).toContain("Ansprechpartner");
    await i18n.changeLanguage("en");
  });
});

describe("OrganisationStep", () => {
  it("wires the name, slug and hint fields with matching describedby ids", () => {
    const html = renderStep((form) => (
      <OrganisationStep form={form} slugEdited={false} onSlugEdited={() => undefined} />
    ));
    expect(html).toContain('id="wizard-name"');
    expect(html).toContain('aria-describedby="wizard-slug-message"');
    expect(html).toContain("Short name for exports and integrations");
    expect(html).toContain("K-1001");
  });

  it("starts every field valid (no aria-invalid) before anything was submitted", () => {
    const html = renderStep((form) => (
      <OrganisationStep form={form} slugEdited={false} onSlugEdited={() => undefined} />
    ));
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).toContain('aria-invalid="false"');
  });

  it("uppercases the country code field and offers both languages", () => {
    const html = renderStep((form) => (
      <OrganisationStep form={form} slugEdited={false} onSlugEdited={() => undefined} />
    ));
    expect(html).toContain('id="wizard-country-code"');
    expect(html).toContain("uppercase");
    expect(html).toContain('id="wizard-language"');
  });
});

describe("ContactsStep", () => {
  it("disables removing the only contact and marks it primary", () => {
    const values = { ...emptyTenantWizardForm("en"), contacts: [emptyContact(true)] };
    const html = renderStep((form) => <ContactsStep form={form} />, values);
    expect(html).toMatch(/disabled=""[^>]*aria-label="Remove this contact"/);
    expect(html).toContain('aria-checked="true"');
  });

  it("lets a second contact be removed", () => {
    const values = {
      ...emptyTenantWizardForm("en"),
      contacts: [emptyContact(true), { ...emptyContact(false), name: "Bob" }],
    };
    const html = renderStep((form) => <ContactsStep form={form} />, values);
    expect(html).toContain('aria-label="Remove Bob"');
    expect(html).not.toMatch(/disabled=""[^>]*aria-label="Remove Bob"/);
  });
});

describe("NotificationsStep", () => {
  it("says that each category becomes a rule, and offers no licence category", () => {
    const html = renderStep((form) => <NotificationsStep form={form} />);
    expect(html).toContain("becomes a rule under Alerts");
    expect(html).toContain("No notification recipients yet.");
    expect(html).not.toContain("does not send any of these e-mails");
  });

  it("checks the categories a recipient already has", () => {
    const values = {
      ...emptyTenantWizardForm("en"),
      notificationRecipients: [
        { ...emptyRecipient(), email: "ops@contoso.example", categories: ["jobFailures" as const] },
      ],
    };
    const html = renderStep((form) => <NotificationsStep form={form} />, values);
    expect(html).toMatch(/aria-checked="true"[^>]*id="wizard-recipient-0-jobFailures"/);
    expect(html).toMatch(/aria-checked="false"[^>]*id="wizard-recipient-0-weeklyReport"/);
  });
});

describe("NotificationsStep: send test mail (interactive)", () => {
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
            <Harness
              defaultValues={emptyTenantWizardForm("en")}
              render={(form) => <NotificationsStep form={form} />}
            />
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

  async function sendTestMail(to: string) {
    await act(async () => {
      setInputValue(container.querySelector("#wizard-test-mail-recipient") as HTMLInputElement, to);
      await flush();
    });
    await act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === "Send test mail",
      ) as HTMLButtonElement;
      button.click();
      await flush();
    });
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

  it("shows the success outcome (ok: true)", async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      transport: "smtp",
      recipient: "ops@contoso.example",
      failure: null,
    });
    mount();
    await sendTestMail("ops@contoso.example");

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/settings/mail/test",
      expect.objectContaining({ method: "POST", body: { to: "ops@contoso.example" } }),
    );
    expect(container.textContent).toContain("Test mail sent to ops@contoso.example via SMTP.");
  });

  it("shows the failure reason once the attempt itself ran (ok: false)", async () => {
    apiFetchMock.mockResolvedValue({
      ok: false,
      transport: "smtp",
      recipient: "ops@contoso.example",
      failure: { reason: "timeout", detail: null },
    });
    mount();
    await sendTestMail("ops@contoso.example");

    expect(container.textContent).toContain("The mail server did not answer in time.");
  });

  it("gives an honest, dedicated message when no transport is configured at all (409)", async () => {
    apiFetchMock.mockRejectedValue(
      new ApiError(
        409,
        {
          type: "urn:restow:problem:mail-not-configured",
          title: "Mail transport not configured",
          status: 409,
        },
        "x",
      ),
    );
    mount();
    await sendTestMail("ops@contoso.example");

    expect(container.textContent).toContain(
      "No mail transport is configured for this installation yet.",
    );
    expect(container.textContent).toContain("Open Settings");
    // Not the generic fallback, and no stale "ok" outcome shown either.
    expect(container.textContent).not.toContain("Something went wrong");
    expect(container.textContent).not.toContain("Test mail sent to");
  });

  it("shows the generic cause for anything else the request itself failed with (403)", async () => {
    apiFetchMock.mockRejectedValue(
      new ApiError(403, { type: "about:blank", title: "Forbidden", status: 403 }, "x"),
    );
    mount();
    await sendTestMail("ops@contoso.example");

    expect(container.textContent).toContain("You do not have permission for this action.");
  });

  it("sends on Enter in the recipient field instead of doing nothing (the wizard's own Enter-advances-step handler must never see this key)", async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      transport: "smtp",
      recipient: "ops@contoso.example",
      failure: null,
    });
    mount();
    await act(async () => {
      setInputValue(
        container.querySelector("#wizard-test-mail-recipient") as HTMLInputElement,
        "ops@contoso.example",
      );
      await flush();
    });
    await act(async () => {
      (container.querySelector("#wizard-test-mail-recipient") as HTMLInputElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await flush();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/settings/mail/test",
      expect.objectContaining({ method: "POST", body: { to: "ops@contoso.example" } }),
    );
    expect(container.textContent).toContain("Test mail sent to ops@contoso.example via SMTP.");
  });
});

describe("AdminsStep", () => {
  it("explains that nobody is invited yet when the list is empty", () => {
    const html = renderStep((form) => <AdminsStep form={form} />);
    expect(html).toContain("Nobody will be invited yet");
  });

  it("renders an email field and a role picker for each administrator", () => {
    const values = { ...emptyTenantWizardForm("en"), admins: [emptyAdmin("tenant_admin")] };
    const html = renderStep((form) => <AdminsStep form={form} />, values);
    expect(html).toContain('id="wizard-admin-0-email"');
    // The role picker (RoleSelect) is a Radix Select: its trigger renders,
    // the selected label only resolves once JS hydrates, so this checks the
    // control is wired rather than its (not yet server-rendered) text.
    expect(html).toContain('id="wizard-admin-0-role"');
    expect(html).toContain('role="combobox"');
  });
});

describe("SourceStep", () => {
  it("points to the Sources page and embeds no source form", () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <SourceStep />
      </I18nextProvider>,
    );
    expect(html).toContain("takes you straight to its Sources page");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });
});

describe("ReviewStep", () => {
  it("summarises the organisation, contacts, notifications and admins entered so far", () => {
    const values: TenantWizardValues = {
      ...emptyTenantWizardForm("en"),
      name: "Contoso GmbH",
      slug: "contoso",
      customerNumber: "K-1001",
      addressLine1: "Hauptstrasse 1",
      city: "Bergisch Gladbach",
      timeZone: "Europe/Berlin",
      contacts: [{ ...emptyContact(true), name: "Alice Admin", email: "alice@contoso.example" }],
      notificationRecipients: [
        { ...emptyRecipient(), email: "ops@contoso.example", categories: ["jobFailures"] },
      ],
      admins: [],
    };
    const html = renderStep((form) => <ReviewStep form={form} />, values);
    expect(html).toContain("Contoso GmbH");
    expect(html).toContain("contoso");
    expect(html).toContain("K-1001");
    expect(html).toContain("Hauptstrasse 1, Bergisch Gladbach");
    // The time zone is not used to schedule anything yet, so the wizard does not ask for it.
    expect(html).not.toContain("Europe/Berlin");
    expect(html).toContain("Alice Admin");
    expect(html).toContain("alice@contoso.example");
    expect(html).toContain("ops@contoso.example");
    expect(html).toContain("Job failures");
    // No administrators entered: the empty state, not a stale count.
    expect(html).toContain("Nobody will be invited yet");
  });

  it("says plainly when there is no customer number, VAT id or address", () => {
    const html = renderStep((form) => <ReviewStep form={form} />, {
      ...emptyTenantWizardForm("en"),
      timeZone: "",
      contacts: [emptyContact(true)],
    });
    expect(html).toContain("No customer number");
    expect(html).toContain("No VAT ID");
    expect(html).toContain("No address");
    expect(html).not.toContain("time zone");
  });
});

// --- TenantWizard (interactive) --------------------------------------------

const session: SessionContextValue = {
  status: "authenticated",
  user: { id: "u1", email: "ops@provider.example", name: "Ops" },
  role: "provider_admin",
  features: ["tenants.additional"],
  extensions: {},
  isProviderAdmin: true,
  tenants: [],
  activeTenant: null,
  setActiveTenant: () => undefined,
  version: null,
  signOut: async () => undefined,
  refresh: async () => undefined,
  error: null,
};

/** Drains pending microtasks (`form.trigger`'s async validation chain) before the next assertion. */
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

async function enter(target: Element) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await flush();
  });
}

function byId<T extends Element = HTMLElement>(container: HTMLElement, id: string): T {
  const element = container.querySelector<T>(`#${id}`);
  if (!element) {
    throw new Error(`expected an element with id "${id}"`);
  }
  return element;
}

function byText(container: HTMLElement, text: string): HTMLElement {
  const match = [...container.querySelectorAll<HTMLElement>("button, a")].find(
    (element) => element.textContent?.trim() === text,
  );
  if (!match) {
    throw new Error(`expected a button or link with the text "${text}"`);
  }
  return match;
}

describe("TenantWizard (interactive)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function mount(sessionValue: SessionContextValue = session) {
    const queryClient = new QueryClient();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>
            <StaticSessionProvider value={sessionValue}>
              <TenantWizard open onOpenChange={() => undefined} />
            </StaticSessionProvider>
          </I18nextProvider>
        </QueryClientProvider>,
      );
    });
  }

  /** Fills the only two required fields (name, the first contact's name) and clicks through to Review. */
  async function fillRequiredFieldsAndReachReview() {
    await type(byId(document.body, "wizard-name"), "Contoso GmbH");
    await click(byText(document.body, "Next"));
    await type(byId(document.body, "wizard-contact-0-name"), "Alice Admin");
    // Contacts, Notifications, Admins, Source: one "Next" click each to Review.
    for (let step = 0; step < 4; step += 1) {
      await click(byText(document.body, "Next"));
    }
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
    navigateSpy.mockReset();
  });

  it("blocks Next on an invalid step and lets it through once the field is valid", async () => {
    mount();
    expect(document.body.querySelector("#wizard-name")).not.toBeNull();

    await click(byText(document.body, "Next"));
    // Still on Organisation: the empty name is invalid, Contacts never rendered.
    expect(document.body.querySelector("#wizard-name")).not.toBeNull();
    expect(document.body.querySelector("#wizard-contact-0-name")).toBeNull();
    expect(byId(document.body, "wizard-name").getAttribute("aria-invalid")).toBe("true");

    await type(byId(document.body, "wizard-name"), "Contoso GmbH");
    await click(byText(document.body, "Next"));
    // Moved on: Contacts is now on screen.
    expect(document.body.querySelector("#wizard-contact-0-name")).not.toBeNull();
  });

  it("shows the interpolated slug-length message, never the raw ICU placeholder", async () => {
    mount();
    await type(byId(document.body, "wizard-name"), "Contoso GmbH");
    // The name auto-fills the slug; type a slug of our own so it is too short.
    await type(byId<HTMLInputElement>(document.body, "wizard-slug"), "a");
    await click(byText(document.body, "Next"));
    // Still on Organisation: the short slug is invalid.
    expect(document.body.querySelector("#wizard-contact-0-name")).toBeNull();
    const shortMessage = byId(document.body, "wizard-slug-message");
    expect(shortMessage.textContent).toBe("Use at least 2 characters.");
    expect(shortMessage.textContent).not.toContain("{min");

    await type(byId<HTMLInputElement>(document.body, "wizard-slug"), "a".repeat(64));
    await click(byText(document.body, "Next"));
    expect(document.body.querySelector("#wizard-contact-0-name")).toBeNull();
    const longMessage = byId(document.body, "wizard-slug-message");
    expect(longMessage.textContent).toBe("Use at most 63 characters.");
    expect(longMessage.textContent).not.toContain("{max");
  });

  it("shows the interpolated slug-length message in German too", async () => {
    await act(async () => {
      await i18n.changeLanguage("de");
    });
    mount();
    await type(byId(document.body, "wizard-name"), "Contoso GmbH");
    await type(byId<HTMLInputElement>(document.body, "wizard-slug"), "a");
    await click(byText(document.body, "Weiter"));
    const shortMessage = byId(document.body, "wizard-slug-message");
    expect(shortMessage.textContent).toBe("Mindestens 2 Zeichen.");
    expect(shortMessage.textContent).not.toContain("{min");
    await i18n.changeLanguage("en");
  });

  it("advances on Enter in a text field, but not on Enter over a button", async () => {
    mount();
    await type(byId(document.body, "wizard-name"), "Contoso GmbH");
    await enter(byId(document.body, "wizard-slug"));
    expect(document.body.querySelector("#wizard-contact-0-name")).not.toBeNull();

    // Enter while a button has focus must not act as "Next" (the wizard's
    // own bug: it used to advance the step from anywhere in the form).
    await enter(byText(document.body, "Add a contact"));
    expect(document.body.querySelector("#wizard-contact-0-name")).not.toBeNull();
    expect(document.body.querySelector("#wizard-recipient-0-email")).toBeNull();

    await enter(byText(document.body, "Back"));
    // Whatever Enter-on-a-button does natively, it must never be *our*
    // handler that pushes the wizard forward to Notifications.
    expect(document.body.querySelector("#wizard-recipient-0-email")).toBeNull();
  });

  it("only lets the step indicator open a step that was already reached", async () => {
    mount();
    await type(byId(document.body, "wizard-name"), "Contoso GmbH");
    await click(byText(document.body, "Next"));
    expect(document.body.querySelector("#wizard-contact-0-name")).not.toBeNull();

    const steps = document.body.querySelector('nav[aria-label="New tenant"]') as HTMLElement;
    const notificationsTab = [...steps.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Notifications"),
    ) as HTMLButtonElement;
    expect(notificationsTab.disabled).toBe(true);
    await click(notificationsTab);
    // Disabled: still on Contacts.
    expect(document.body.querySelector("#wizard-contact-0-name")).not.toBeNull();

    const organisationTab = [...steps.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Organisation"),
    ) as HTMLButtonElement;
    expect(organisationTab.disabled).toBe(false);
    await click(organisationTab);
    expect(document.body.querySelector("#wizard-name")).not.toBeNull();
  });

  it("keeps exactly one contact primary after removing the primary row, without the user touching the radio", async () => {
    mount();
    await type(byId(document.body, "wizard-name"), "Contoso GmbH");
    await click(byText(document.body, "Next")); // Contacts
    await type(byId(document.body, "wizard-contact-0-name"), "Alice Admin");
    await click(byText(document.body, "Add a contact"));
    await type(byId(document.body, "wizard-contact-1-name"), "Bob Backup");
    expect(byId(document.body, "wizard-contact-0-primary").getAttribute("aria-checked")).toBe(
      "true",
    );

    // Remove the primary row (Alice, index 0).
    const removeAlice = [...document.body.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Remove Alice Admin",
    ) as HTMLButtonElement;
    await click(removeAlice);

    // Bob is now the only, first row, and already primary: "Next" is not
    // blocked by "exactly one primary contact" left unset for the user to
    // notice and fix.
    expect(document.body.querySelector("#wizard-contact-1-name")).toBeNull();
    expect(byId(document.body, "wizard-contact-0-primary").getAttribute("aria-checked")).toBe(
      "true",
    );
    await click(byText(document.body, "Next"));
    // Moved on to Notifications (its test-mail card is always present).
    expect(document.body.querySelector("#wizard-test-mail-recipient")).not.toBeNull();
  });

  it("shows the cause and stays on Review when creating the tenant fails", async () => {
    apiFetchMock.mockRejectedValue(
      new ApiError(500, { type: "about:blank", title: "Server error", status: 500 }, "x"),
    );
    mount();
    await fillRequiredFieldsAndReachReview();
    expect(document.body.textContent).toContain("Review");

    await click(byText(document.body, "Create tenant"));

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/tenants",
      expect.objectContaining({ method: "POST" }),
    );
    expect(document.body.textContent).toContain("The server reported an internal error.");
    // No success screen: Review's own fields are still present.
    expect(document.body.querySelector("#wizard-contact-0-name")).toBeNull();
    expect(byText(document.body, "Create tenant")).toBeTruthy();
  });

  it("lists who was added directly and who was invited on success, without claiming an e-mail was sent", async () => {
    apiFetchMock.mockImplementation(
      async (path: string, init?: { method?: string; body?: unknown }) => {
        if (path === "/tenants" && init?.method === "POST") {
          return {
            id: "tenant-1",
            name: "Contoso GmbH",
            slug: "contoso",
            status: "active",
            organizationId: "org-1",
            mailboxCap: null,
            createdAt: null,
            updatedAt: null,
          };
        }
        if (path === "/tenants/tenant-1/members" && init?.method === "POST") {
          const body = init.body as { email: string; role: string };
          if (body.email === "ada@contoso.example") {
            return { status: "member", userId: "u1", email: body.email, role: body.role };
          }
          return {
            status: "invited",
            invitationId: "inv-1",
            email: body.email,
            role: body.role,
            expiresAt: "2026-10-01T00:00:00.000Z",
          };
        }
        if (path === "/setup/state") {
          return { microsoftSignIn: false };
        }
        throw new Error(`unexpected request: ${path}`);
      },
    );
    mount();
    await type(byId(document.body, "wizard-name"), "Contoso GmbH");
    await click(byText(document.body, "Next")); // Contacts
    await type(byId(document.body, "wizard-contact-0-name"), "Alice Admin");
    await click(byText(document.body, "Next")); // Notifications
    await click(byText(document.body, "Next")); // Admins
    await click(byText(document.body, "Add an administrator"));
    await type(byId(document.body, "wizard-admin-0-email"), "ada@contoso.example");
    await click(byText(document.body, "Add an administrator"));
    await type(byId(document.body, "wizard-admin-1-email"), "bob@contoso.example");
    await click(byText(document.body, "Next")); // Source
    await click(byText(document.body, "Next")); // Review
    await click(byText(document.body, "Create tenant"));

    const text = document.body.textContent ?? "";
    expect(text).toContain("ada@contoso.example");
    expect(text).toContain("Added, can sign in right away");
    expect(text).toContain("bob@contoso.example");
    expect(text).toContain("Invited, valid until");
    // Honest completeness: nothing claims an e-mail went out for the invited
    // administrator, and no stale "could not be invited" warning shows for
    // two admins that both succeeded.
    expect(text).toContain("No e-mail was sent");
    expect(text).not.toMatch(/could not be invited/);
    // The mocked setup state has no Microsoft sign-in: the wizard must warn
    // that an invited person with no existing account has no way in yet.
    expect(text).toContain("Sign-in with Microsoft is not available in this release");
  });

  it("shows the Source step's explanation exactly once, not duplicated by the step body", async () => {
    mount();
    await type(byId(document.body, "wizard-name"), "Contoso GmbH");
    await click(byText(document.body, "Next")); // Contacts
    await type(byId(document.body, "wizard-contact-0-name"), "Alice Admin");
    await click(byText(document.body, "Next")); // Notifications
    await click(byText(document.body, "Next")); // Admins
    await click(byText(document.body, "Next")); // Source

    const description =
      "Connect the customer's Microsoft 365 tenant or an IMAP mailbox once the tenant is created.";
    const text = document.body.textContent ?? "";
    const occurrences = text.split(description).length - 1;
    expect(occurrences).toBe(1);
    // The step body adds the practical detail (where to go), not a restatement.
    expect(text).toContain("takes you straight to its Sources page");
  });

  it("switches to the new tenant and navigates there exactly once from 'Connect a source now'", async () => {
    apiFetchMock.mockImplementation(
      async (path: string, init?: { method?: string; body?: unknown }) => {
        if (path === "/tenants" && init?.method === "POST") {
          return {
            id: "tenant-1",
            name: "Contoso GmbH",
            slug: "contoso",
            status: "active",
            organizationId: "org-1",
            mailboxCap: null,
            createdAt: null,
            updatedAt: null,
          };
        }
        if (path === "/setup/state") {
          return { microsoftSignIn: false };
        }
        throw new Error(`unexpected request: ${path}`);
      },
    );
    const setActiveTenant = vi.fn();
    mount({ ...session, setActiveTenant });
    await fillRequiredFieldsAndReachReview();
    await click(byText(document.body, "Create tenant"));

    await click(byText(document.body, "Connect a source now"));

    // One switch, one navigation: no detour through the dashboard and no
    // second "entered <tenant>" toast on top of the "created" one.
    expect(setActiveTenant).toHaveBeenCalledTimes(1);
    expect(setActiveTenant).toHaveBeenCalledWith("tenant-1");
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/sources" });
  });

  it("jumps back to the first invalid step when Create is refused for the slug", async () => {
    apiFetchMock.mockRejectedValue(
      new ApiError(
        409,
        { type: "urn:restow:problem:slug-taken", title: "Slug taken", status: 409 },
        "x",
      ),
    );
    mount();
    await fillRequiredFieldsAndReachReview();

    await click(byText(document.body, "Create tenant"));

    // The slug conflict is shown on the field, back on Organisation.
    expect(document.body.querySelector("#wizard-name")).not.toBeNull();
    expect(byId(document.body, "wizard-slug").getAttribute("aria-invalid")).toBe("true");
  });

  it("jumps back to Organisation when Create is refused for a duplicate customer number", async () => {
    apiFetchMock.mockRejectedValue(
      new ApiError(
        409,
        {
          type: "urn:restow:problem:customer-number-taken",
          title: "Customer number taken",
          status: 409,
        },
        "x",
      ),
    );
    mount();
    await fillRequiredFieldsAndReachReview();

    await click(byText(document.body, "Create tenant"));

    // The conflict is shown on the field, back on Organisation, not left for
    // the user to discover only from a generic error on Review.
    expect(document.body.querySelector("#wizard-name")).not.toBeNull();
    expect(byId(document.body, "wizard-customer-number").getAttribute("aria-invalid")).toBe("true");
  });
});
