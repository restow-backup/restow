import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { sessionAs } from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { StaticSessionProvider } from "@/lib/session";

import "../i18n";
import { storageKeys } from "../api";
import type { PrimaryWriteOnce } from "../types";
import { WriteOnceRetentionNotice } from "../write-once";
import { WriteOnceLine } from "./write-once-line";

/**
 * Write-once storage (docs/STORAGE.md, "Write-once storage"): the repository card says what
 * changes there, and the pages that show retention say that it is not applied.
 */

function render(node: React.ReactNode, client = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <StaticSessionProvider value={sessionAs({})}>
        <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
      </StaticSessionProvider>
    </QueryClientProvider>,
  );
}

describe("write-once storage in the interface", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("says what changes on a write-once repository, and nothing on another", () => {
    const html = render(
      <WriteOnceLine
        finding={{
          writeOnce: true,
          refused: ["overwrite", "delete"],
          code: "EPERM",
          checkedAt: "2026-11-05T10:00:00.000Z",
        }}
      />,
    );
    expect(html).toContain("Write-once storage");
    expect(html).toContain("could neither overwrite nor delete its test object (EPERM)");
    expect(html).toContain("Retention is not applied here");
    expect(html).toContain("Lock files of every backup stay");
    expect(html).toContain("fresh folder");
    expect(html).toContain("Backups, restores and restore checks work as usual.");
    expect(
      render(
        <WriteOnceLine
          finding={{ writeOnce: false, refused: [], code: null, checkedAt: "2026-11-05T10:00:00Z" }}
        />,
      ),
    ).toBe("");
    expect(render(<WriteOnceLine finding={null} />)).toBe("");
  });

  it("tells a page that retention is not applied while the primary is write-once", () => {
    const client = new QueryClient();
    // The session's tenant: the query is disabled without one, the cached answer still shows.
    const tenantId = sessionAs({}).activeTenant?.id ?? null;
    const answer: PrimaryWriteOnce = {
      writeOnce: true,
      targetName: "NAS WORM",
      installationDefault: false,
      checkedAt: "2026-11-05T10:00:00.000Z",
      refused: ["delete"],
    };
    client.setQueryData([...storageKeys.all(tenantId), "write-once"], answer);
    const html = render(<WriteOnceRetentionNotice context="guest" />, client);
    expect(html).toContain("Retention is not applied");
    expect(html).toContain("go to NAS WORM, which is write-once storage");
    client.setQueryData([...storageKeys.all(tenantId), "write-once"], {
      ...answer,
      writeOnce: false,
    });
    expect(render(<WriteOnceRetentionNotice context="guest" />, client)).toBe("");
  });
});
