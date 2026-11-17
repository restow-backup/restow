// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { RestoreMarker } from "@/components/layout/restore-marker";

describe("RestoreMarker", () => {
  it("is drawn only, in the success colour, and hidden in the collapsed rail", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<RestoreMarker />));
    const mark = host.querySelector('[data-slot="restore-marker"]');
    expect(mark?.getAttribute("aria-hidden")).toBe("true");
    expect(mark?.className).toContain("bg-success");
    expect(mark?.className).toContain("group-data-[collapsible=icon]:hidden");
    expect(mark?.querySelector("svg")).not.toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
