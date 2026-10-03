// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";

import { DisabledReason } from "./disabled-reason.js";

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("DisabledReason", () => {
  it("wraps a disabled control in a focusable element", () => {
    const el = render(
      <DisabledReason reason="Only owners can do this.">
        <Button disabled>Run</Button>
      </DisabledReason>,
    );
    const wrapper = el.querySelector('[data-slot="disabled-reason"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.getAttribute("tabindex")).toBe("0");
    expect(wrapper?.querySelector("button")?.disabled).toBe(true);
  });

  it("renders the child alone without a reason", () => {
    const el = render(
      <DisabledReason reason={null}>
        <Button>Run</Button>
      </DisabledReason>,
    );
    expect(el.querySelector('[data-slot="disabled-reason"]')).toBeNull();
    expect(el.querySelector("button")).not.toBeNull();
  });
});
