// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { AuditActionCount } from "../api";
import { useAuditFormat } from "../hooks";
import "../i18n";
import { ActionFilter } from "./action-filter";

/**
 * The audit log's action filter: a searchable list grouped by category, where
 * the category row itself filters by the whole category (the URL keeps the
 * dotted prefix) and no separate "All events: …" row exists. Typing filters by
 * the labels in the UI language; Escape closes the list and returns focus to
 * the trigger, which shows the whole chosen label.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACTIONS: AuditActionCount[] = [
  { action: "restore.requested", count: 4 },
  { action: "restore.downloaded", count: 1 },
  { action: "tenant.created", count: 2 },
  { action: "backup.requested", count: 7 },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function Harness({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (action: string | undefined) => void;
}) {
  const format = useAuditFormat();
  return (
    <>
      <span id="action-label">{format.t("filters.action")}</span>
      <ActionFilter
        id="action"
        labelId="action-label"
        value={value}
        actions={ACTIONS}
        format={format}
        onChange={onChange}
      />
    </>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderFilter(
  language: "de" | "en",
  value: string | undefined,
  onChange = vi.fn(),
): Promise<HTMLButtonElement> {
  await i18n.changeLanguage(language);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <Harness value={value} onChange={onChange} />
      </I18nextProvider>,
    );
  });
  await flush();
  return host.querySelector<HTMLButtonElement>("#action") as HTMLButtonElement;
}

async function open(trigger: HTMLButtonElement): Promise<void> {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    trigger.click();
  });
  await flush();
}

function options(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
}

async function type(text: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>("[cmdk-input]");
  if (!input) {
    throw new Error("no search field");
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      input,
      text,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

describe("audit action filter", () => {
  it("lists categories as choices of their own, with every action below them", async () => {
    const trigger = await renderFilter("de", undefined);
    expect(trigger.getAttribute("role")).toBe("combobox");
    expect(trigger.textContent).toContain("Alle Aktionen");
    await open(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // The trigger controls the popup that holds the named list and the named search field.
    const popup = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
    const listbox = popup?.querySelector('[role="listbox"]');
    expect(listbox?.getAttribute("aria-label")).toBe("Aktion");
    const input = popup?.querySelector("[cmdk-input]");
    const inputLabel = document.getElementById(input?.getAttribute("aria-labelledby") ?? "");
    expect(inputLabel?.textContent).toBe("Aktion oder Kategorie suchen …");
    const labels = options().map((option) => option.textContent?.trim());
    expect(labels[0]).toBe("Alle Aktionen");
    expect(labels).toContain("Wiederherstellung");
    expect(labels).toContain("Wiederherstellung angefordert");
    expect(labels.some((label) => label?.startsWith("Alle Ereignisse"))).toBe(false);

    const category = options().find((option) => option.textContent?.trim() === "Wiederherstellung");
    expect(category?.getAttribute("aria-label")).toBe("Alle Ereignisse: Wiederherstellung");
  });

  it("filters by what is typed and chooses the whole category", async () => {
    const onChange = vi.fn();
    const trigger = await renderFilter("de", undefined, onChange);
    await open(trigger);
    await type("wiederher");
    expect(options().map((option) => option.textContent?.trim())).toEqual([
      "Wiederherstellung",
      "Wiederherstellung angefordert",
      "Wiederherstellung heruntergeladen",
    ]);

    const category = options()[0];
    await act(async () => {
      category?.click();
    });
    await flush();
    expect(onChange).toHaveBeenCalledWith("restore");
  });

  it("finds actions in English too", async () => {
    const trigger = await renderFilter("en", undefined);
    await open(trigger);
    await type("requested");
    const labels = options().map((option) => option.textContent?.trim());
    expect(labels).toContain("Restore requested");
    expect(labels).not.toContain("Tenant created");
  });

  it("shows the whole chosen label on the trigger, for categories and for links it does not list", async () => {
    const category = await renderFilter("de", "restore");
    expect(category.textContent).toContain("Alle Ereignisse: Wiederherstellung");
    act(() => root?.unmount());
    host?.remove();

    const action = await renderFilter("en", "restore.requested");
    expect(action.textContent).toContain("Restore requested");
    act(() => root?.unmount());
    host?.remove();

    // An old link to a category with no entries in this scope still shows as chosen.
    const unlisted = await renderFilter("de", "webhook");
    expect(unlisted.textContent).toContain("Alle Ereignisse: Webhooks");
  });

  it("returns focus to the trigger on Escape", async () => {
    const trigger = await renderFilter("de", undefined);
    await open(trigger);
    const input = document.body.querySelector<HTMLInputElement>("[cmdk-input]");
    expect(input).not.toBeNull();
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});
