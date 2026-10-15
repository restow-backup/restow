import type * as React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import "../i18n";
import { MachineDataFoldersNotice, MissingDataFoldersNotice } from "./missing-data-folders";
import { ProfileNote } from "./profile-note";

/** The notice about data folders a machine job leaves out (#59). */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ className, children }: { className?: string; children: React.ReactNode }) => (
      <a href="/job" className={className}>
        {children}
      </a>
    ),
  };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("MissingDataFoldersNotice", () => {
  it("names what a client-style job leaves out and offers to add it", () => {
    const html = render(
      <MissingDataFoldersNotice
        paths={["/etc", "/home", "/root", "/srv", "/var/www"]}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("/opt, /usr/local, /var/lib, /var/backups");
    expect(html).toContain("Add these 4 folders");
  });

  it("explains a restore point without an add button", () => {
    const html = render(
      <MissingDataFoldersNotice paths={["/etc", "/home"]} context="restorePoint" />,
    );
    expect(html).toContain("This restore point does not contain every data folder");
    expect(html).not.toContain("<button");
  });

  it("says nothing when every data folder is covered", () => {
    expect(render(<MissingDataFoldersNotice paths={["/"]} />)).toBe("");
  });

  it("names what the agents found, with their machines, once one reports", () => {
    const html = render(
      <MissingDataFoldersNotice
        paths={["/etc", "/home", "/root", "/srv", "/var/www"]}
        excludes={["/var/lib/docker"]}
        reports={[
          { name: "paperless", folders: ["/opt", "/var/lib/docker/volumes"] },
          { name: "db01", folders: ["/opt", "/srv"] },
          { name: "old", folders: null },
        ]}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("Folders with data on the machines are not backed up");
    expect(html).toContain("on paperless, db01");
    expect(html).toContain("/var/lib/docker/volumes");
    expect(html).toContain("the exclusion of /var/lib/docker is narrowed");
    expect(html).toContain("skips it, without an error");
    expect(html).toContain("Add these 2 folders");
    expect(html).toContain('aria-label="Add /opt to the job"');
    // Only what is there: no /usr/local guess.
    expect(html).not.toContain("/usr/local");
  });

  it("says nothing when the job backs up everything the agents found", () => {
    expect(
      render(
        <MissingDataFoldersNotice
          paths={["/etc"]}
          reports={[{ name: "web01", folders: [] }]}
          onAdd={() => undefined}
        />,
      ),
    ).toBe("");
  });
});

describe("MachineDataFoldersNotice", () => {
  const job = { id: "7d0c3c8e-0000-4000-8000-000000000001", name: "Paperless" };

  it("offers to add the folders to the machine's job", () => {
    const html = render(
      <MachineDataFoldersNotice
        job={job}
        dataFolders={{ missing: ["/opt"], ownFolders: false }}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("the job Paperless does not back up: /opt.");
    expect(html).toContain("Add this folder to the job");
    expect(html).toContain("Open job");
  });

  it("sends a machine with folders of its own to the job", () => {
    const html = render(
      <MachineDataFoldersNotice
        job={job}
        dataFolders={{ missing: ["/opt"], ownFolders: true }}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("folders of its own in the job");
    expect(html).not.toContain("Add this folder");
  });

  it("says nothing without a job or without a report", () => {
    expect(
      render(
        <MachineDataFoldersNotice
          job={null}
          dataFolders={{ missing: ["/opt"], ownFolders: false }}
        />,
      ),
    ).toBe("");
    expect(render(<MachineDataFoldersNotice job={job} dataFolders={null} />)).toBe("");
  });
});

describe("ProfileNote", () => {
  const machine = {
    endpointId: "e1",
    name: "paperless",
    os: "linux",
    profile: "client" as const,
    folders: null,
    reportedAt: null,
    machine: null,
    profileDetection: null,
  };

  it("says what a client's default folders cover", () => {
    const html = render(<ProfileNote machines={[machine]} />);
    expect(html).toContain("Client:");
    expect(html).toContain("only the user folders and the configuration");
  });

  it("names the machines per profile when they differ, and why one is a server", () => {
    const html = render(
      <ProfileNote
        machines={[
          machine,
          {
            ...machine,
            endpointId: "e2",
            name: "ct-101",
            profile: "server",
            profileDetection: { requested: "client", reason: "container", technology: "lxc" },
          },
        ]}
      />,
    );
    expect(html).toContain("Client (paperless):");
    expect(html).toContain("Server (ct-101):");
    expect(html).toContain("ct-101 was added as a client and runs in a container");
  });

  it("says nothing for a Mac", () => {
    expect(render(<ProfileNote machines={[{ ...machine, os: "darwin" }]} />)).toBe("");
  });
});
