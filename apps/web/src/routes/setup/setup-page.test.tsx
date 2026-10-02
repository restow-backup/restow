// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type * as React from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/components/theme-provider";
import { i18n } from "@/i18n";
import { type SetupState, queryKeys } from "@/lib/api";

import { SetupPage } from "./index";

/**
 * The wizard, driven with real DOM events through the real page. The language
 * comes first: preselected from the browser, applied at once to every text,
 * and sent with the setup request. Then the setup token is checked on the
 * server before anything else shows, a wrong one is refused in place, and the
 * operator responsibility notice keeps Continue disabled until the box is
 * ticked and sends nothing itself. The mail transport can be skipped: the
 * review says so and the request carries no mail. The setup request carries
 * the token as a header and the acceptance in its body; a token that changed
 * in between (the api restarted) leads back to the token step. The server's
 * own refusals are proven in apps/api (routes/setup.pg.test.ts,
 * routes/setup.language.pg.test.ts).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const VERSION = "2026-09-30";

const freshState: SetupState = {
  configured: false,
  productName: "Restow",
  operatingMode: null,
  publicUrl: null,
  passkeyReady: { ready: false, reasons: ["mode_not_public"], rpId: null, origin: null },
  mailTransport: null,
  disclaimer: { version: VERSION, accepted: false },
  setupToken: { required: true, source: "log" },
  microsoftSignIn: false,
  demo: { enabled: false, email: null, password: null },
};

/** The demo: no setup token, the notice counts as accepted. */
const demoState: SetupState = {
  ...freshState,
  disclaimer: { version: VERSION, accepted: true },
  setupToken: { required: false, source: null },
  demo: { enabled: true, email: "demo@example.com", password: "demo" },
};

const TOKEN = "K7PQX-3MZRA-T9WHE-2BNCV";

const fetchMock = vi.fn();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let container: HTMLDivElement;
let root: Root;

async function mount(state: SetupState): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.setupState, state);
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <SetupPage />
          </QueryClientProvider>
        </ThemeProvider>
      </I18nextProvider>,
    );
    await flush();
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    (element as HTMLElement).click();
    await flush();
  });
}

function checkbox(): HTMLButtonElement {
  const box = container.querySelector<HTMLButtonElement>('[role="checkbox"]');
  if (!box) {
    throw new Error("expected the notice checkbox");
  }
  return box;
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) {
    throw new Error(`expected a button labelled "${label}"`);
  }
  return match;
}

/** Type into a form control the way a person does (React sees an input event). */
async function type(id: string, value: string): Promise<void> {
  const element = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!element) {
    throw new Error(`expected a control #${id}`);
  }
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

/** Enter the token and get past the first step (the server answers 204). */
async function passTokenStep(): Promise<void> {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await type("setup-token", TOKEN);
  await click(button("Next"));
}

/** The first step: the language is preselected, so continuing is all it takes. */
async function passLanguageStep(): Promise<void> {
  await click(button("Next"));
}

/** The radio of one of the two language cards. */
function languageRadio(language: "en" | "de"): HTMLInputElement {
  const radio = container.querySelector<HTMLInputElement>(
    `input[name="setup-language"][value="${language}"]`,
  );
  if (!radio) {
    throw new Error(`expected the language card for ${language}`);
  }
  return radio;
}

/** Make the browser report `language` as its preferred one (navigator.language). */
function browserSpeaks(language: string): void {
  vi.spyOn(window.navigator, "language", "get").mockReturnValue(language);
}

/** The requests the page sent, as "METHOD /path". */
function requests(): string[] {
  return fetchMock.mock.calls.map(([url, init]) => {
    const path = String(url).replace(/^.*\/api\/v1/, "");
    return `${(init as RequestInit | undefined)?.method ?? "GET"} ${path}`;
  });
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

/** In-memory Storage: Node 25's own global localStorage needs a backing file. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, String(value));
    },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // No earlier visit: nothing stored, no language chosen.
  vi.stubGlobal("localStorage", memoryStorage());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  navigateSpy.mockReset();
  // The tests read the wizard in English; one that changed the language puts it back.
  await i18n.changeLanguage("en");
  vi.unstubAllGlobals();
});

describe("setup wizard, language step", () => {
  it("is the first step, with two choices that each name themselves in their own language", async () => {
    await mount(freshState);

    expect(container.textContent).toContain("Step 1 of 7");
    expect(container.textContent).toContain("Choose your language");
    // Each card is in its own language, whatever the page speaks right now.
    expect(container.textContent).toContain("English");
    expect(container.textContent).toContain(
      "Set up in English, with mails and reports in English.",
    );
    expect(container.textContent).toContain("Deutsch");
    expect(container.textContent).toContain(
      "Auf Deutsch einrichten, mit Mails und Berichten auf Deutsch.",
    );
    expect(container.querySelector('[lang="de"]')).not.toBeNull();
    // Nothing else of the wizard is reachable before it, and nothing was sent.
    expect(container.textContent).not.toContain("Confirm that you run this server");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button("Back").disabled).toBe(true);
  });

  it("preselects English for an English browser", async () => {
    browserSpeaks("en-GB");
    await mount(freshState);

    expect(languageRadio("en").checked).toBe(true);
    expect(languageRadio("de").checked).toBe(false);
  });

  it("preselects the browser's language and runs the whole wizard in it", async () => {
    browserSpeaks("de-AT");
    await mount(freshState);

    expect(languageRadio("de").checked).toBe(true);
    expect(languageRadio("en").checked).toBe(false);
    // The texts of the step itself are German at once, not only after a click.
    expect(container.textContent).toContain("Schritt 1 von 7");
    expect(container.textContent).toContain("Wählen Sie Ihre Sprache");
    expect(container.textContent).not.toContain("Choose your language");
    expect(document.documentElement.lang).toBe("de");

    await click(button("Weiter"));
    expect(container.textContent).toContain("Schritt 2 von 7");
    expect(container.textContent).toContain("Bestätigen Sie, dass Sie diesen Server betreiben");
    expect(container.textContent).toContain("Einmal-Code");
  });

  it("falls back to English for a browser language the wizard does not offer", async () => {
    browserSpeaks("fr-FR");
    await mount(freshState);

    expect(languageRadio("en").checked).toBe(true);
    expect(container.textContent).toContain("Choose your language");
  });

  it("switches every text at once when the other language is picked, and remembers it", async () => {
    await mount(freshState);
    expect(container.textContent).toContain("Choose your language");

    await click(languageRadio("de"));

    expect(languageRadio("de").checked).toBe(true);
    expect(container.textContent).toContain("Wählen Sie Ihre Sprache");
    expect(container.textContent).toContain("Schritt 1 von 7");
    expect(container.textContent).not.toContain("Choose your language");
    expect(localStorage.getItem("restow.language")).toBe("de");

    // And back: the first card is English again, and so is everything around it.
    await click(languageRadio("en"));
    expect(container.textContent).toContain("Choose your language");
    expect(localStorage.getItem("restow.language")).toBe("en");
  });

  it("keeps the language the visitor chose before, whatever the browser says", async () => {
    await i18n.changeLanguage("de");
    localStorage.setItem("restow.language.chosen", "1");
    browserSpeaks("en-US");
    await mount(freshState);

    expect(languageRadio("de").checked).toBe(true);
    expect(container.textContent).toContain("Wählen Sie Ihre Sprache");
  });

  it("goes on in the chosen language and sends it with the setup", async () => {
    await mount(freshState);
    await click(languageRadio("de"));
    await click(button("Weiter"));

    expect(container.textContent).toContain("Schritt 2 von 7");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await type("setup-token", TOKEN);
    await click(button("Weiter"));
    await click(checkbox());
    await click(button("Weiter"));
    // Operating mode, then the organisation and the first admin.
    await click(button("Weiter"));
    await type("organisation-name", "Beispiel IT-Service GmbH");
    await type("admin-name", "Betreiber");
    await type("admin-email", "ops@example.com");
    await type("admin-password", "correct-horse-battery-1");
    await type("admin-confirm", "correct-horse-battery-1");
    await click(button("Weiter"));
    await type("smtp-host", "mail.example.com");
    await type("smtp-from", "restow@example.com");
    await click(button("Weiter"));
    expect(container.textContent).toContain("Schritt 7 von 7");
    // The review names the language the operator picked.
    expect(container.textContent).toContain("Sprache");
    expect(container.textContent).toContain("Deutsch");

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      json(403, {
        type: "urn:restow:problem:setup-token-invalid",
        title: "Setup token required",
        status: 403,
      }),
    );
    await click(button("Einrichtung abschließen"));

    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.language).toBe("de");
  });
});

describe("setup wizard, setup token step", () => {
  it("follows the language, then explains the setup token and says where to find it", async () => {
    await mount(freshState);
    await passLanguageStep();

    expect(container.textContent).toContain("Step 2 of 7");
    expect(container.textContent).toContain("Confirm that you run this server");
    // What it is: a one-time code that proves the operator runs the server.
    expect(container.textContent).toContain("one-time code that proves you operate this server");
    expect(container.textContent).toContain("stops working once the setup is finished");
    // Where it is: the installer printed it, and the exact command shows it again.
    expect(container.textContent).toContain("The installer printed it at the end");
    expect(container.querySelector("pre")?.textContent).toBe(
      "cd /opt/restow && sudo docker compose logs api | grep 'SETUP TOKEN'",
    );
    // Neither the notice nor the operating mode is reachable yet.
    expect(container.textContent).not.toContain("Your responsibility as operator");
    expect(container.textContent).not.toContain("How do you run Restow?");
  });

  it("points at RESTOW_SETUP_TOKEN when the server takes the token from its environment", async () => {
    await mount({ ...freshState, setupToken: { required: true, source: "environment" } });
    await passLanguageStep();

    expect(container.textContent).toContain("RESTOW_SETUP_TOKEN");
    expect(container.textContent).not.toContain("docker compose logs api");
  });

  it("asks for a token before sending anything", async () => {
    await mount(freshState);
    await passLanguageStep();

    await click(button("Next"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter the setup token.");
    expect(container.textContent).toContain("Step 2 of 7");
  });

  it("stays on the step when the server refuses the token", async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, {
        type: "urn:restow:problem:setup-token-invalid",
        title: "Setup token required",
        status: 403,
      }),
    );
    await mount(freshState);
    await passLanguageStep();

    await type("setup-token", "WRONG-TOKEN");
    await click(button("Next"));

    expect(requests()).toEqual(["POST /setup/token"]);
    const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get("x-restow-setup-token")).toBe("WRONG-TOKEN");
    expect(container.textContent).toContain("This is not the setup token of this server.");
    expect(container.textContent).toContain("Step 2 of 7");
  });

  it("moves on to the notice once the server accepts the token", async () => {
    await mount(freshState);
    await passLanguageStep();

    await passTokenStep();

    expect(requests()).toEqual(["POST /setup/token"]);
    expect(container.textContent).toContain("Step 3 of 7");
    expect(container.textContent).toContain("Your responsibility as operator");
  });

  it("skips the token in the demo, which has none, and the notice, which counts as accepted", async () => {
    await mount(demoState);

    // The language is the first step everywhere; the steps that do not apply are passed over.
    expect(container.textContent).toContain("Step 1 of 7");
    expect(container.textContent).toContain("Choose your language");
    await passLanguageStep();

    expect(container.textContent).toContain("Step 4 of 7");
    expect(container.textContent).toContain("How do you run Restow?");

    // Back goes the same way: past the token and the notice, to the language.
    await click(button("Back"));
    expect(container.textContent).toContain("Step 1 of 7");
  });
});

describe("setup wizard, operator notice step", () => {
  it("shows the notice in the operator's words and with the branded product name", async () => {
    await mount(freshState);
    await passLanguageStep();
    await passTokenStep();

    expect(container.textContent).toContain("Your responsibility as operator");
    // The text speaks of the branded product name, not a hard-coded one.
    expect(container.textContent).toContain("Restow is a tool for backup and archiving");
    for (const point of [
      "No replacement for a backup strategy",
      "Hardware and storage",
      "Ransomware and deletion",
      "Encryption keys",
      "Network and access",
      "Test your restores",
      "Archive and GoBD",
      "No warranty",
    ]) {
      expect(container.textContent).toContain(point);
    }
    expect(container.textContent).toContain("designed for GoBD-compliant use");
    expect(container.textContent).toContain(`Version ${VERSION}`);
    // The operating mode is not reachable yet.
    expect(container.textContent).not.toContain("How do you run Restow?");
  });

  it("keeps Continue disabled until the box is ticked, and again when it is cleared", async () => {
    await mount(freshState);
    await passLanguageStep();
    await passTokenStep();

    expect(checkbox().getAttribute("aria-checked")).toBe("false");
    expect(button("Continue").disabled).toBe(true);
    expect(container.textContent).toContain("Tick the box to continue.");

    await click(checkbox());
    expect(checkbox().getAttribute("aria-checked")).toBe("true");
    expect(button("Continue").disabled).toBe(false);

    await click(checkbox());
    expect(button("Continue").disabled).toBe(true);
  });

  it("moves on without a request of its own: the acceptance goes with the setup", async () => {
    await mount(freshState);
    await passLanguageStep();
    await passTokenStep();

    await click(checkbox());
    await click(button("Continue"));

    expect(requests()).toEqual(["POST /setup/token"]);
    expect(container.textContent).toContain("Step 4 of 7");
    expect(container.textContent).toContain("How do you run Restow?");
  });
});

describe("setup wizard, organisation and first admin", () => {
  async function toAdminStep(): Promise<void> {
    await mount(freshState);
    await passLanguageStep();
    await passTokenStep();
    await click(checkbox());
    await click(button("Continue"));
    await click(button("Next"));
    expect(container.textContent).toContain("Step 5 of 7");
  }

  it("asks for the name of the organisation next to the first admin", async () => {
    await toAdminStep();

    expect(container.textContent).toContain("Your organisation and the first admin account");
    expect(container.querySelector("#organisation-name")).not.toBeNull();
    expect(container.querySelector("#admin-email")).not.toBeNull();
  });

  it("does not let the setup go on without a name for the organisation", async () => {
    await toAdminStep();
    await type("admin-name", "Operator");
    await type("admin-email", "ops@example.com");
    await type("admin-password", "correct-horse-battery-1");
    await type("admin-confirm", "correct-horse-battery-1");

    await click(button("Next"));
    expect(container.textContent).toContain("Step 5 of 7");
    expect(container.textContent).toContain("This field is required.");

    // Only blanks do not count as a name.
    await type("organisation-name", "   ");
    await click(button("Next"));
    expect(container.textContent).toContain("Step 5 of 7");

    await type("organisation-name", "Example IT Services GmbH");
    await click(button("Next"));
    expect(container.textContent).toContain("Step 6 of 7");
  });
});

describe("setup wizard, skipping the mail transport", () => {
  async function toMailStep(): Promise<void> {
    await mount(freshState);
    await passLanguageStep();
    await passTokenStep();
    await click(checkbox());
    await click(button("Continue"));
    await click(button("Next"));
    await type("organisation-name", "Example IT Services GmbH");
    await type("admin-name", "Operator");
    await type("admin-email", "ops@example.com");
    await type("admin-password", "correct-horse-battery-1");
    await type("admin-confirm", "correct-horse-battery-1");
    await click(button("Next"));
    expect(container.textContent).toContain("Step 6 of 7");
  }

  it("offers 'Skip for now' and says what does not work without mail and where to set it up", async () => {
    await toMailStep();

    expect(button("Skip for now")).toBeTruthy();
    expect(container.textContent).toContain("Mail is optional.");
    expect(container.textContent).toContain("sends no alert or report e-mails");
    expect(container.textContent).toContain(
      "invitations and set-password links are not sent by mail",
    );
    expect(container.textContent).toContain("Installation → Notification mail");
  });

  it("says the same in German, with 'Später einrichten' and the German menu path", async () => {
    await mount(freshState);
    await click(languageRadio("de"));
    await click(button("Weiter"));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await type("setup-token", TOKEN);
    await click(button("Weiter"));
    await click(checkbox());
    await click(button("Weiter"));
    await click(button("Weiter"));
    await type("organisation-name", "Beispiel IT-Service GmbH");
    await type("admin-name", "Betreiber");
    await type("admin-email", "ops@example.com");
    await type("admin-password", "correct-horse-battery-1");
    await type("admin-confirm", "correct-horse-battery-1");
    await click(button("Weiter"));

    expect(container.textContent).toContain("Schritt 6 von 7");
    expect(button("Später einrichten")).toBeTruthy();
    expect(container.textContent).toContain("Mail ist optional.");
    expect(container.textContent).toContain("Installation → Benachrichtigungs-Mail");

    await click(button("Später einrichten"));
    expect(container.textContent).toContain("Schritt 7 von 7");
    expect(container.textContent).toContain("Nicht eingerichtet");
  });

  it("goes to the review without a form to fill in, which says 'Not set up'", async () => {
    await toMailStep();

    // Nothing was typed: the transport form is empty and would not validate.
    await click(button("Skip for now"));

    expect(container.textContent).toContain("Step 7 of 7");
    expect(container.textContent).toContain("Mail transport");
    expect(container.textContent).toContain("Not set up");
    // No test message without a transport.
    expect(container.textContent).not.toContain("Test message");
  });

  it("sends the setup without mail and without a test message", async () => {
    await toMailStep();
    await click(button("Skip for now"));
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      json(403, {
        type: "urn:restow:problem:setup-token-invalid",
        title: "Setup token required",
        status: 403,
      }),
    );

    await click(button("Finish setup"));

    expect(requests()).toEqual(["POST /setup"]);
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("mail");
    expect(body.sendTest).toBe(false);
    expect(body.providerName).toBe("Example IT Services GmbH");
    expect(body.language).toBe("en");
  });

  it("does not send what was typed before skipping", async () => {
    await toMailStep();
    await type("smtp-host", "mail.example.com");
    await type("smtp-from", "restow@example.com");
    await click(button("Skip for now"));
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      json(403, {
        type: "urn:restow:problem:setup-token-invalid",
        title: "Setup token required",
        status: 403,
      }),
    );

    await click(button("Finish setup"));

    const sent = (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string;
    expect(sent).not.toContain("mail.example.com");
    expect(JSON.parse(sent)).not.toHaveProperty("mail");
  });

  it("asks for the mail again when the operator comes back and chooses Next", async () => {
    await toMailStep();
    await click(button("Skip for now"));
    await click(button("Back"));

    expect(container.textContent).toContain("Step 6 of 7");
    expect(container.textContent).toContain("You skipped this step.");

    // Next means "set it up now": the empty form is refused in place.
    await click(button("Next"));
    expect(container.textContent).toContain("Step 6 of 7");
    expect(container.textContent).toContain("This field is required.");

    await type("smtp-host", "mail.example.com");
    await type("smtp-from", "restow@example.com");
    await click(button("Next"));
    expect(container.textContent).toContain("Step 7 of 7");
    expect(container.textContent).toContain("SMTP server");
    expect(container.textContent).not.toContain("Not set up");
  });
});

describe("setup wizard, finishing", () => {
  async function fillUpToReview(): Promise<void> {
    await mount(freshState);
    await passLanguageStep();
    await passTokenStep();
    await click(checkbox());
    await click(button("Continue"));
    // Operating mode: local, the default.
    await click(button("Next"));
    await type("organisation-name", "Example IT Services GmbH");
    await type("admin-name", "Operator");
    await type("admin-email", "ops@example.com");
    await type("admin-password", "correct-horse-battery-1");
    await type("admin-confirm", "correct-horse-battery-1");
    await click(button("Next"));
    await type("smtp-host", "mail.example.com");
    await type("smtp-from", "restow@example.com");
    await click(button("Next"));
    expect(container.textContent).toContain("Step 7 of 7");
  }

  it("sends the token as a header and the accepted notice in the body", async () => {
    await fillUpToReview();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      json(403, {
        type: "urn:restow:problem:setup-token-invalid",
        title: "Setup token required",
        status: 403,
      }),
    );

    await click(button("Finish setup"));

    expect(requests()).toEqual(["POST /setup"]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("x-restow-setup-token")).toBe(TOKEN);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.disclaimer).toEqual({ version: VERSION, accepted: true });
    expect(body.firstAdmin).toMatchObject({ email: "ops@example.com" });
    // The name of the operator's own organisation, which the server creates it with.
    expect(body.providerName).toBe("Example IT Services GmbH");
    // The language of the first step, which becomes that organisation's language.
    expect(body.language).toBe("en");
    expect(body.mail).toMatchObject({ transport: "smtp", smtp: { host: "mail.example.com" } });
    expect(body.sendTest).toBe(true);
  });

  it("shows the organisation in the review", async () => {
    await fillUpToReview();

    expect(container.textContent).toContain("Your organisation");
    expect(container.textContent).toContain("Example IT Services GmbH");
  });

  it("goes back to the first step when the token changed in between, keeping the entries", async () => {
    await fillUpToReview();
    fetchMock.mockResolvedValueOnce(
      json(403, {
        type: "urn:restow:problem:setup-token-invalid",
        title: "Setup token required",
        status: 403,
      }),
    );

    await click(button("Finish setup"));

    expect(container.textContent).toContain("Step 2 of 7");
    expect(container.textContent).toContain("The setup token has changed");
    // Everything entered so far is still there.
    expect(container.querySelector<HTMLInputElement>("#setup-token")?.value).toBe(TOKEN);
    await passTokenStep();
    await click(button("Continue"));
    await click(button("Next"));
    expect(container.querySelector<HTMLInputElement>("#admin-email")?.value).toBe(
      "ops@example.com",
    );
    // Back on the review, the token problem is not shown again as a failed setup.
    await click(button("Next"));
    await click(button("Next"));
    expect(container.textContent).toContain("Step 7 of 7");
    expect(container.textContent).not.toContain("The setup could not be saved.");
  });

  it("goes back to the notice when the server moved on to a newer text", async () => {
    await fillUpToReview();
    fetchMock.mockResolvedValueOnce(
      json(409, {
        type: "urn:restow:problem:disclaimer-version-mismatch",
        title: "Operator notice changed",
        status: 409,
      }),
    );

    await click(button("Finish setup"));

    expect(container.textContent).toContain("Step 3 of 7");
    expect(container.textContent).toContain("The notice was updated. Reload the page");
    expect(button("Reload")).toBeTruthy();
    expect(checkbox().getAttribute("aria-checked")).toBe("false");
  });
});
