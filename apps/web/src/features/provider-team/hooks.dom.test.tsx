// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { queryKeys } from "@/lib/api";

import { teamKeys } from "./api";
import { useUpdateMember } from "./hooks";

/**
 * A change to the team re-reads the own profile too: it carries the own
 * provider role, so a change that touched it never leaves buttons the API
 * then refuses until the next reload.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: vi.fn().mockResolvedValue({}),
}));

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe("team mutations", () => {
  it("invalidate the member list and the own profile", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    let update: ReturnType<typeof useUpdateMember> | null = null;
    function Probe() {
      update = useUpdateMember();
      return null;
    }
    root = createRoot(document.createElement("div"));
    await act(async () => {
      root?.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await update?.mutateAsync({
        userId: "u-1",
        input: { role: "administrator", allTenants: true, tenantIds: [] },
      });
    });
    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toContainEqual(teamKeys.list);
    expect(keys).toContainEqual(queryKeys.me);
  });
});
