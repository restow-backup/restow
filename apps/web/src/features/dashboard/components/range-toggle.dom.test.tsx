// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { StorageRangeToggle } from "./range-toggle.js";

/**
 * The storage window is a radio group the keyboard can work: Tab lands on the
 * chosen range, the arrow keys move between the ranges, Space or Enter (a
 * click on the focused button) chooses one, and choosing the chosen one again
 * keeps it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(onChange: (value: string) => void) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <I18nextProvider i18n={i18n}>
        <StorageRangeToggle value="30d" onChange={onChange} />
      </I18nextProvider>,
    ),
  );
  const radios = [...(host.querySelectorAll('[role="radio"]') as NodeListOf<HTMLButtonElement>)];
  return { group: host.querySelector('[role="radiogroup"]') as HTMLElement, radios };
}

describe("StorageRangeToggle", () => {
  it("is a radio group named Period with the chosen range checked", () => {
    const { group, radios } = mount(() => {});
    expect(group.getAttribute("aria-label")).toBe("Period");
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "1 week",
      "1 month",
      "3 months",
      "1 year",
    ]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    // Roving focus: Tab reaches the group once, which hands the focus to the chosen range.
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1, -1, -1]);
    act(() => group.focus());
    expect(document.activeElement).toBe(radios[1]);
  });

  it("moves with the arrow keys and chooses the focused range", async () => {
    const onChange = vi.fn();
    const { radios } = mount(onChange);
    act(() => radios[1]?.focus());
    await act(async () => {
      radios[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      // The roving focus moves on the next task.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(radios[2]);
    act(() => radios[2]?.click());
    expect(onChange).toHaveBeenCalledWith("90d");
  });

  it("keeps the chosen range when it is chosen again", () => {
    const onChange = vi.fn();
    const { radios } = mount(onChange);
    act(() => radios[1]?.click());
    expect(onChange).not.toHaveBeenCalled();
  });
});
