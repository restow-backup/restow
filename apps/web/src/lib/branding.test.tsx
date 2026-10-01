// @vitest-environment happy-dom
import { DEFAULT_PRODUCT_NAME } from "@restow/i18n";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider, useTranslation } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { applyProductName } from "./branding";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Texts that name the product the way the app's screens do: the wordmark and a sentence. */
function Probe() {
  const { t } = useTranslation();
  return (
    <p>
      <span data-testid="name">{t("common:app.name")}</span>
      <span data-testid="sentence">{t("common:errors.shellTitle")}</span>
    </p>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  applyProductName(undefined);
});

function mount(): void {
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <Probe />
      </I18nextProvider>,
    ),
  );
}

function text(id: string): string {
  return container.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
}

describe("applyProductName", () => {
  it("shows the default name until the api names the product", () => {
    mount();
    expect(text("name")).toBe(DEFAULT_PRODUCT_NAME);
    expect(text("sentence")).toBe(`${DEFAULT_PRODUCT_NAME} could not be loaded`);
  });

  it("re-renders every text that names the product, in either language", async () => {
    mount();
    act(() => applyProductName("Acme Backup"));
    expect(text("name")).toBe("Acme Backup");
    expect(text("sentence")).toBe("Acme Backup could not be loaded");

    await act(async () => {
      await i18n.changeLanguage("de");
    });
    expect(text("sentence")).toBe("Acme Backup konnte nicht geladen werden");
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  });

  it("falls back to the default for a missing or blank name", () => {
    mount();
    act(() => applyProductName("Acme Backup"));
    act(() => applyProductName("   "));
    expect(text("name")).toBe(DEFAULT_PRODUCT_NAME);
    act(() => applyProductName("Acme Backup"));
    act(() => applyProductName(undefined));
    expect(text("name")).toBe(DEFAULT_PRODUCT_NAME);
  });
});
