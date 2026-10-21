import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveRepositoryChain, PveRun } from "./api";
import { historyRows, RepositoryChainNotice } from "./guest-page";

/**
 * A container's new backup chain on its page (docs/PVE.md, "New backup chain"): what the
 * notice says for a repository not found and for a reset, and the chain in the guest's history.
 */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

const missing: PveRepositoryChain = {
  at: "2026-10-20T22:00:05.000Z",
  reason: "missing",
  target: { name: "NAS", kind: "local", location: "/mnt/nas", installationDefault: false },
  unavailablePoints: 4,
  actor: null,
};

describe("the notice of a new backup chain", () => {
  it("says the previous repository was not found, where, and what became unavailable", () => {
    const html = render(<RepositoryChainNotice chain={missing} />);
    expect(html).toContain("New backup chain started on");
    expect(html).toContain("The previous repository was not found at NAS (/mnt/nas)");
    expect(html).toContain("4 earlier restore points are no longer available");
  });

  it("names the installation default without a path, and who reset the repository", () => {
    const html = render(
      <RepositoryChainNotice
        chain={{
          ...missing,
          reason: "reset",
          actor: "admin@contoso.example",
          unavailablePoints: 1,
          target: {
            name: "Installation default",
            kind: "local",
            location: null,
            installationDefault: true,
          },
        }}
      />,
    );
    expect(html).toContain("Repository reset on");
    expect(html).toContain("admin@contoso.example reset the repository");
    expect(html).toContain("the installation default");
    expect(html).toContain("1 earlier restore point is no longer available");
  });
});

describe("the guest's history", () => {
  it("puts the new chain between the runs, newest first", () => {
    const run = (id: string, startedAt: string): PveRun =>
      ({ id, kind: "backup", status: "succeeded", startedAt }) as PveRun;
    const rows = historyRows(
      [run("new", "2026-10-21T22:00:00.000Z"), run("old", "2026-10-19T22:00:00.000Z")],
      [missing],
    );
    expect(rows.map((row) => (row.type === "run" ? row.run.id : "chain"))).toEqual([
      "new",
      "chain",
      "old",
    ]);
  });
});
