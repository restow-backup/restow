import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEMO_MACHINES,
  type FileContent,
  type FileOp,
  applyOps,
  assertEmptyRoots,
  hostPath,
  planEndpointHistory,
  screenshotName,
  screenshotsIn,
} from "./endpoint-files.js";
import { zonedParts } from "./tz.js";

const NOW = new Date("2026-09-30T01:10:00Z");
const SHOTS = ["overview.png", "team.png", "statistics.png"];
const OPTIONS = { seed: 20260101, now: NOW, days: 30, screenshots: SHOTS };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** Replay the steps of a machine into a map from path to content. */
function replay(machine: string, steps: ReturnType<typeof planEndpointHistory>) {
  const files = new Map<string, FileContent>();
  const sizes: number[] = [];
  for (const step of steps.filter((s) => s.machine === machine)) {
    for (const op of step.ops) {
      if (op.op === "put") files.set(op.file.path, op.file.content);
      else files.delete(op.path);
    }
    sizes.push(files.size);
  }
  return { files, sizes };
}

/** Printable ASCII, tab and line feed only: no umlauts, no accents, no symbols a PDF font lacks. */
const isPlainAscii = (text: string): boolean =>
  [...text].every((char) => char === "\n" || char === "\t" || (char >= " " && char <= "~"));

/** One hash over everything a plan says: the moments, the paths, the times and the bytes. */
function fingerprint(steps: ReturnType<typeof planEndpointHistory>): string {
  const hash = createHash("sha256");
  for (const step of steps) {
    hash.update(`${step.machine}|${step.index}|${step.at.toISOString()}\n`);
    for (const op of step.ops) {
      if (op.op === "remove") {
        hash.update(`rm ${op.path}\n`);
      } else {
        hash.update(`put ${op.file.path} ${op.file.mtime.toISOString()} `);
        hash.update(
          Buffer.isBuffer(op.file.content)
            ? op.file.content
            : `screenshot:${op.file.content.screenshot}`,
        );
        hash.update("\n");
      }
    }
  }
  return hash.digest("hex");
}

const textOf = (content: FileContent): string | null =>
  Buffer.isBuffer(content) &&
  !content.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "latin1")) &&
  !content.subarray(0, 4).equals(Buffer.from("%PDF"))
    ? content.toString("utf8")
    : null;

describe("the simulated machines", () => {
  it("are one Linux server of Example Trading and one Mac of Birchwood", () => {
    const [server, laptop] = DEMO_MACHINES;
    expect(server).toMatchObject({
      hostname: "fileserver-01",
      kind: "server",
      os: "linux",
      tenantSlug: "example-trading",
    });
    expect(laptop).toMatchObject({
      hostname: "laptop-jdoe",
      kind: "client",
      os: "darwin",
      arch: "arm64",
      tenantSlug: "birchwood-consulting",
    });
    expect(server?.paths).toEqual(["/srv/share", "/etc/samba", "/var/log/samba"]);
    expect(laptop?.paths).toEqual(["/Users/jdoe"]);
    for (const machine of DEMO_MACHINES) {
      expect(machine.osVersion).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe("planEndpointHistory", () => {
  const plan = planEndpointHistory(OPTIONS);

  it("is deterministic for a seed, a clock and the screenshots", { timeout: 30_000 }, () => {
    expect(fingerprint(planEndpointHistory(OPTIONS))).toBe(fingerprint(plan));
    expect(fingerprint(planEndpointHistory({ ...OPTIONS, seed: 7 }))).not.toBe(fingerprint(plan));
    expect(
      fingerprint(planEndpointHistory({ ...OPTIONS, now: new Date(NOW.getTime() + 86_400_000) })),
    ).not.toBe(fingerprint(plan));
  });

  it("plans several backups per machine, oldest first, none in the future", () => {
    expect(plan.map((s) => s.at.getTime())).toEqual(
      [...plan.map((s) => s.at.getTime())].sort((a, b) => a - b),
    );
    for (const machine of DEMO_MACHINES) {
      const own = plan.filter((s) => s.machine === machine.hostname);
      expect(own.length).toBeGreaterThanOrEqual(10);
      expect(own.length).toBeLessThanOrEqual(30);
      expect(own.map((s) => s.index)).toEqual(own.map((_, i) => i));
      for (const step of own) {
        expect(step.at.getTime()).toBeLessThanOrEqual(NOW.getTime() - 5 * 60_000);
      }
      // One backup per day at most: the retention (daily 30) must not thin the history.
      const days = own.map((s) => s.at.toISOString().slice(0, 10));
      expect(new Set(days).size).toBe(days.length);
    }
  });

  it("backs the server up every night at 22:00 Berlin time, the laptop on working days", () => {
    const server = plan.filter((s) => s.machine === "fileserver-01");
    for (const step of server) {
      const local = zonedParts(step.at, "Europe/Berlin");
      expect(local.hour).toBe(22);
      expect(local.minute).toBeLessThanOrEqual(25);
    }
    // Every night, nothing missed: 29 or 30 days.
    expect(server.length).toBeGreaterThanOrEqual(29);
    const laptop = plan.filter((s) => s.machine === "laptop-jdoe");
    for (const step of laptop) {
      const local = zonedParts(step.at, "Europe/Berlin");
      const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
      expect([1, 2, 3, 4, 5]).toContain(weekday);
      expect(local.hour).toBeGreaterThanOrEqual(16);
      expect(local.hour).toBeLessThanOrEqual(18);
    }
    expect(laptop.length).toBeLessThan(server.length);
  });

  it("writes the whole tree first and changes a few files after that", () => {
    for (const machine of DEMO_MACHINES) {
      const own = plan.filter((s) => s.machine === machine.hostname);
      const first = own[0]?.ops.length ?? 0;
      expect(first).toBeGreaterThan(20);
      for (const step of own.slice(1)) {
        expect(step.ops.length).toBeGreaterThan(0);
        expect(step.ops.length).toBeLessThan(first);
      }
      // Files are added, changed and removed along the way.
      const ops = own.slice(1).flatMap((s) => s.ops);
      const puts = new Set<string>();
      let changed = 0;
      let added = 0;
      for (const step of own) {
        for (const op of step.ops) {
          if (op.op === "put") {
            if (puts.has(op.file.path)) changed += 1;
            else added += 1;
            puts.add(op.file.path);
          }
        }
      }
      expect(added).toBeGreaterThan(first);
      expect(changed).toBeGreaterThan(5);
      expect(ops.some((op) => op.op === "remove")).toBe(true);
    }
  });

  it("only removes files that exist and never leaves a modification time in the future", () => {
    for (const machine of DEMO_MACHINES) {
      const known = new Set<string>();
      for (const step of plan.filter((s) => s.machine === machine.hostname)) {
        for (const op of step.ops) {
          if (op.op === "put") {
            known.add(op.file.path);
            expect(op.file.mtime.getTime(), op.file.path).toBeLessThanOrEqual(step.at.getTime());
          } else {
            expect(known.has(op.path), op.path).toBe(true);
            known.delete(op.path);
          }
        }
      }
    }
  });

  it("keeps every path inside the folders the machine backs up", () => {
    for (const machine of DEMO_MACHINES) {
      for (const step of plan.filter((s) => s.machine === machine.hostname)) {
        for (const op of step.ops) {
          const path = op.op === "put" ? op.file.path : op.path;
          expect(
            machine.paths.some((root) => path === root || path.startsWith(`${root}/`)),
            path,
          ).toBe(true);
        }
      }
    }
  });

  it("gives the server invoices, reports, contracts, notes, a Samba config and log, and screenshots", () => {
    const { files } = replay("fileserver-01", plan);
    const paths = [...files.keys()];
    expect(
      paths.filter((p) => /\/Finance\/Invoices\/\d{4}\/INV-\d{4}-\d{4}-.*\.pdf$/.test(p)).length,
    ).toBeGreaterThan(10);
    expect(paths.some((p) => /\/Finance\/Reports\/Monthly-report-\d{4}-\d{2}\.pdf$/.test(p))).toBe(
      true,
    );
    expect(paths.some((p) => p.startsWith("/srv/share/Contracts/") && p.endsWith(".pdf"))).toBe(
      true,
    );
    expect(paths.some((p) => p.endsWith("/meeting-notes.txt"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/plan.md"))).toBe(true);
    expect(paths).toContain("/etc/samba/smb.conf");
    expect(paths).toContain("/var/log/samba/log.smbd");
    expect(paths.some((p) => p.endsWith(".png"))).toBe(true);
    // The log grows and is rotated; the configuration changes once.
    const logs = plan
      .filter((s) => s.machine === "fileserver-01")
      .flatMap((s) => s.ops)
      .filter((op) => op.op === "put" && op.file.path === "/var/log/samba/log.smbd");
    expect(logs.length).toBeGreaterThan(20);
    expect(paths).toContain("/var/log/samba/log.smbd.1");
    const conf = plan
      .flatMap((s) => s.ops)
      .filter((op) => op.op === "put" && op.file.path === "/etc/samba/smb.conf");
    expect(conf).toHaveLength(2);
  });

  it("gives the laptop documents, notes, macOS-named screenshots and dotfiles", () => {
    const { files } = replay("laptop-jdoe", plan);
    const paths = [...files.keys()];
    expect(paths.some((p) => /^\/Users\/jdoe\/Documents\/Clients\/.*\.pdf$/.test(p))).toBe(true);
    expect(paths.some((p) => /^\/Users\/jdoe\/Documents\/Invoices\/INV-.*\.pdf$/.test(p))).toBe(
      true,
    );
    expect(paths.some((p) => /^\/Users\/jdoe\/Documents\/Notes\/.*\.md$/.test(p))).toBe(true);
    expect(paths).toContain("/Users/jdoe/Documents/todo.txt");
    expect(paths).toContain("/Users/jdoe/.gitconfig");
    expect(
      paths.some((p) =>
        /^\/Users\/jdoe\/(Desktop|Pictures\/Screenshots)\/Screenshot \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.png$/.test(
          p,
        ),
      ),
    ).toBe(true);
  });

  it("writes English, ASCII-only text with documentation addresses and example domains", () => {
    for (const step of plan) {
      for (const op of step.ops) {
        if (op.op !== "put") continue;
        const text = textOf(op.file.content);
        if (text === null) continue;
        expect(isPlainAscii(text), op.file.path).toBe(true);
        for (const ip of text.match(/\b\d+\.\d+\.\d+\.\d+\b/g) ?? []) {
          expect(ip.startsWith("192.0.2."), `${op.file.path}: ${ip}`).toBe(true);
        }
        for (const domain of text.match(/@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []) {
          expect(domain, op.file.path).toMatch(/@(.+\.)?example\.(org|com|net)$/);
        }
      }
    }
  });

  it("makes PDFs that are PDFs and pictures that are PNG or named screenshots", () => {
    for (const op of plan.flatMap((s) => s.ops)) {
      if (op.op !== "put") continue;
      const { path, content } = op.file;
      if (path.endsWith(".pdf")) {
        expect(Buffer.isBuffer(content)).toBe(true);
        expect((content as Buffer).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
        expect((content as Buffer).toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
      }
      if (path.endsWith(".png")) {
        if (Buffer.isBuffer(content)) {
          expect(content.subarray(1, 4).toString("ascii")).toBe("PNG");
          expect(content.length).toBeLessThan(16 * 1024);
        } else {
          expect(SHOTS).toContain(content.screenshot);
        }
      }
    }
  });

  it("works without screenshots (generated pictures only) and for a single day", () => {
    const bare = planEndpointHistory({ ...OPTIONS, screenshots: [] });
    for (const op of bare.flatMap((s) => s.ops)) {
      if (op.op === "put" && op.file.path.endsWith(".png")) {
        expect(Buffer.isBuffer(op.file.content)).toBe(true);
      }
    }
    const single = planEndpointHistory({ ...OPTIONS, days: 0 });
    expect(single).toHaveLength(2);
    for (const step of single) {
      expect(step.index).toBe(0);
      expect(step.at.getTime()).toBeLessThan(NOW.getTime());
    }
    expect(planEndpointHistory({ ...OPTIONS, days: 3 }).length).toBeLessThanOrEqual(6);
  });

  it("names screenshots the way macOS does, in local time", () => {
    expect(screenshotName(new Date("2026-09-14T08:42:17Z"), "Europe/Berlin")).toBe(
      "Screenshot 2026-09-14 at 10.42.17.png",
    );
  });
});

describe("writing the machines' files", () => {
  it("maps a machine path under a simulated root, or leaves it as is for /", () => {
    expect(hostPath("/", "/srv/share/a.txt")).toBe("/srv/share/a.txt");
    expect(hostPath("/tmp/sim", "/srv/share/a.txt")).toBe("/tmp/sim/srv/share/a.txt");
  });

  it("writes puts with their modification times, copies screenshots and removes files", () => {
    const shots = tmp("restow-shots-");
    const root = tmp("restow-sim-");
    writeFileSync(join(shots, "overview.png"), "png-bytes");
    const mtime = new Date("2026-09-01T10:00:00Z");
    const ops: FileOp[] = [
      { op: "put", file: { path: "/srv/share/a/b.txt", content: Buffer.from("hello"), mtime } },
      {
        op: "put",
        file: { path: "/srv/share/pic.png", content: { screenshot: "overview.png" }, mtime },
      },
      { op: "put", file: { path: "/srv/share/gone.txt", content: Buffer.from("x"), mtime } },
    ];
    expect(applyOps(root, ops, shots)).toEqual({ written: 3, removed: 0 });
    expect(readFileSync(join(root, "srv/share/a/b.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(root, "srv/share/pic.png"), "utf8")).toBe("png-bytes");
    expect(statSync(join(root, "srv/share/a/b.txt")).mtime.getTime()).toBe(mtime.getTime());
    expect(applyOps(root, [{ op: "remove", path: "/srv/share/gone.txt" }], shots)).toEqual({
      written: 0,
      removed: 1,
    });
    expect(existsSync(join(root, "srv/share/gone.txt"))).toBe(false);
    // Removing what is not there is not an error.
    applyOps(root, [{ op: "remove", path: "/srv/share/never.txt" }], shots);
  });

  it("gives the folders a change touches the time of the change, not the time the seed ran", () => {
    const shots = tmp("restow-shots-");
    const root = tmp("restow-sim-");
    const first = new Date("2026-09-01T10:00:00Z");
    const later = new Date("2026-09-05T11:30:00Z");
    const removedAt = new Date("2026-09-06T20:00:00Z");
    applyOps(
      root,
      [
        {
          op: "put",
          file: {
            path: "/srv/share/Finance/Invoices/a.pdf",
            content: Buffer.from("a"),
            mtime: first,
          },
        },
        {
          op: "put",
          file: { path: "/srv/share/Admin/b.txt", content: Buffer.from("b"), mtime: first },
        },
      ],
      shots,
    );
    const mtime = (path: string) => statSync(join(root, path)).mtime.getTime();
    expect(mtime("srv/share/Finance/Invoices")).toBe(first.getTime());
    expect(mtime("srv/share/Finance")).toBe(first.getTime());
    expect(mtime("srv/share")).toBe(first.getTime());

    // A new file in an existing folder touches that folder only; changing a file touches none.
    applyOps(
      root,
      [
        {
          op: "put",
          file: {
            path: "/srv/share/Finance/Invoices/c.pdf",
            content: Buffer.from("c"),
            mtime: later,
          },
        },
        {
          op: "put",
          file: { path: "/srv/share/Admin/b.txt", content: Buffer.from("b2"), mtime: later },
        },
      ],
      shots,
    );
    expect(mtime("srv/share/Finance/Invoices")).toBe(later.getTime());
    expect(mtime("srv/share/Finance")).toBe(first.getTime());
    expect(mtime("srv/share/Admin")).toBe(first.getTime());

    // A removal touches the folder at the moment of the backup.
    applyOps(root, [{ op: "remove", path: "/srv/share/Admin/b.txt" }], shots, removedAt);
    expect(mtime("srv/share/Admin")).toBe(removedAt.getTime());
  });

  it("replays a whole plan to disk", () => {
    const shots = tmp("restow-shots-");
    for (const name of SHOTS) writeFileSync(join(shots, name), name);
    const root = tmp("restow-sim-");
    const plan = planEndpointHistory(OPTIONS);
    for (const step of plan) applyOps(root, step.ops, shots);
    for (const machine of DEMO_MACHINES) {
      const { files } = replay(machine.hostname, plan);
      for (const path of files.keys()) {
        expect(existsSync(hostPath(root, path)), path).toBe(true);
      }
    }
  });

  it("refuses to write into folders that already hold files", () => {
    const root = tmp("restow-sim-");
    assertEmptyRoots(root, DEMO_MACHINES);
    mkdirSync(join(root, "srv/share"), { recursive: true });
    assertEmptyRoots(root, DEMO_MACHINES);
    writeFileSync(join(root, "srv/share/precious.txt"), "do not mix");
    expect(() => assertEmptyRoots(root, DEMO_MACHINES)).toThrow(/not empty/);
  });

  it("lists only PNG screenshots, sorted, and none for a missing folder", () => {
    const shots = tmp("restow-shots-");
    writeFileSync(join(shots, "b.png"), "x");
    writeFileSync(join(shots, "a.png"), "x");
    writeFileSync(join(shots, "notes.txt"), "not a screenshot");
    expect(screenshotsIn(shots)).toEqual(["a.png", "b.png"]);
    expect(screenshotsIn(join(shots, "missing"))).toEqual([]);
  });
});
