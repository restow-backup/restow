// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import "@/i18n";

import { DetailHover } from "./detail-hover.js";

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const message =
  'unable to restore CT 122 - Can\'t use string ("restow") as a HASH ref while "strict refs" in use';

describe("DetailHover", () => {
  it("opens on keyboard focus with the whole text, selectable and with a Copy button", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        <DetailHover text={message} title="Did not boot" tone="destructive">
          <span>Did not boot</span>
        </DetailHover>,
      ),
    );
    const trigger = host.querySelector<HTMLElement>('[data-slot="hover-card-trigger"]');
    expect(trigger?.tagName).toBe("BUTTON");
    expect(document.querySelector('[data-slot="detail-hover"]')).toBeNull();

    await act(async () => {
      trigger?.focus();
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    const card = document.querySelector('[data-slot="detail-hover"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector("pre")?.textContent).toBe(message);
    expect(card?.querySelector("button")).not.toBeNull();
  });
});
