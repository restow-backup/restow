import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveRepositoryChain, PveRepositoryProblem, PveRun } from "./api";
import { historyRows, RepositoryChainNotice, RepositoryProblemNotice } from "./guest-page";

/**
 * A container's new backup chain on its page (docs/PVE.md, "Repository problems"): what the
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

describe("the notice of a refused backup (docs/PVE.md, Repository problems)", () => {
  const problem: PveRepositoryProblem = {
    at: "2026-10-22T08:00:00.000Z",
    type: "pve-repository-split",
    heldBy: "installation_default",
    activePoints: 1,
  };

  it("says the repository is split, where its parts are, and the two ways out", () => {
    const html = render(<RepositoryProblemNotice problem={problem} />);
    expect(html).toContain("Backups refused: the repository is split across storage targets");
    expect(html).toContain("parts of it lie on the installation default");
    expect(html).toContain("Repository repair");
    expect(html).toContain("1 restore point becomes unavailable");
  });

  it("names the target of a repository found elsewhere, and a missing one's restore points", () => {
    const elsewhere = render(
      <RepositoryProblemNotice
        problem={{ ...problem, type: "pve-repository-elsewhere", heldBy: "Old NAS" }}
      />,
    );
    expect(elsewhere).toContain("but on Old NAS");
    const missing = render(
      <RepositoryProblemNotice
        problem={{ ...problem, type: "pve-repository-missing", heldBy: null, activePoints: 5 }}
      />,
    );
    expect(missing).toContain("5 restore points still refer to it");
    expect(missing).toContain("attach it read-only");
  });

  it("shows nothing for a problem type it does not know", () => {
    expect(render(<RepositoryProblemNotice problem={{ ...problem, type: "other" }} />)).toBe("");
  });

  it("explains a chain the repository repair began", () => {
    const html = render(
      <RepositoryChainNotice
        chain={{ ...missing, reason: "lost", actor: "admin@contoso.example", unavailablePoints: 2 }}
      />,
    );
    expect(html).toContain("Repository lost on");
    expect(html).toContain("2 restore points are no longer available");
  });
});
