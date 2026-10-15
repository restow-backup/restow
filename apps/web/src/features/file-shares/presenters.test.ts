import de from "@restow/i18n/resources/de/fileshares.json" with { type: "json" };
import en from "@restow/i18n/resources/en/fileshares.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";

import { FILE_SHARE_PROBLEMS } from "./api.js";
import {
  ITEM_CODES,
  budgetPercent,
  checkConnection,
  connectionInputOf,
  defaultRestoreFolder,
  itemCodeKey,
  locationOfDraft,
  looksPrivate,
  newConnectionDraft,
  passwordProblem,
  permissionLevel,
  progressRatio,
  readinessView,
  restoreDefaults,
  runStatusView,
  shareErrorKey,
  standingView,
  suggestedName,
} from "./presenters.js";

/**
 * The file share pages as data (docs/FILESHARES.md 12): words and tones, the add dialog's checks
 * (the API's rules), the restore defaults of 4.7, and the `fileshares` namespace: the same keys
 * and ICU arguments in both languages, and every key the code builds at runtime.
 */

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") result.set(path, value);
    else for (const [leaf, text] of leaves(value, path)) result.set(leaf, text);
  }
  return result;
}

const english = leaves(en as Tree);
const german = leaves(de as Tree);
const args = (message: string) =>
  [...new Set([...message.matchAll(/\{(\w+)\s*[,}]/g)].map((match) => match[1]))].sort();

const sourceFiles = import.meta.glob(
  [
    "./**/*.ts",
    "./**/*.tsx",
    "!./**/*.test.ts",
    "!./**/*.test.tsx",
    "!./fixtures.ts",
    "!./testing.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

describe("fileshares translations", () => {
  it("have the same keys and ICU arguments in German and English", () => {
    expect([...german.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, text] of english) {
      expect(args(german.get(key) ?? ""), key).toEqual(args(text));
    }
  });

  it("contain every literal key the feature names", () => {
    const keys = new Set<string>();
    for (const source of Object.values(sourceFiles)) {
      for (const match of source.matchAll(/\bt\(\s*"([\w.-]+)"/g)) keys.add(match[1] ?? "");
      for (const match of source.matchAll(/\?\s*"([a-z]+\.[\w.-]+)"\s*:\s*"([a-z]+\.[\w.-]+)"/g)) {
        keys.add(match[1] ?? "");
        keys.add(match[2] ?? "");
      }
    }
    expect(keys.size).toBeGreaterThan(200);
    for (const key of keys) {
      expect(english.has(key), key).toBe(true);
    }
  });

  it("name every state, phase, destination, option, code and field built at runtime", () => {
    const required = [
      ...["retired", "failed", "running", "overdue", "warning", "no_job", "no_backup", "ok"].map(
        (state) => standingView(state as never).key,
      ),
      ...["green", "yellow", "red", "unverified", "no_backup"].map(
        (state) => readinessView(state as never).key,
      ),
      ...[
        "queued",
        "starting",
        "running",
        "succeeded",
        "restored",
        "warning",
        "failed",
        "cancelled",
      ].map((status) => `runs.status.${status}`),
      ...["backup", "restore", "copy"].map((kind) => `runs.kind.${kind}`),
      ...["original", "new_folder", "folder", "other_share"].map(
        (key) => `runs.destinations.${key}`,
      ),
      ...["zip", "original", "new_folder", "other_share"].map((key) => `restore.options.${key}`),
      ...["original", "new_folder", "other_share"].map((key) => `restore.summary.${key}`),
      ...["overwrite", "keep_both", "skip"].flatMap((mode) => [
        `restore.conflict.${mode}`,
        `restore.conflictHint.${mode}`,
      ]),
      ...[...ITEM_CODES, "other"].map((code) => `items.codes.${code}`),
      ...["full", "owner", "dacl", "nfs", "none"].map((level) => `add.test.permissions.${level}`),
      ...["protocol", "connection", "test", "options"].map((step) => `add.steps.${step}`),
      ...["smb", "nfs"].flatMap((protocol) => [
        `add.protocol.${protocol}.title`,
        `add.protocol.${protocol}.description`,
        `protocol.${protocol}`,
      ]),
      ...["3_1_1", "3_0", "2_1"].map((version) => `add.smbVersions.${version}`),
      ...[
        "required",
        "serverNoProtocol",
        "serverInvalid",
        "shareInvalid",
        "subfolderInvalid",
        "accountInvalid",
        "domainInvalid",
        "passwordTooLong",
        "passwordControl",
        "passwordMountFlag",
        "sealNeedsSmb3",
      ].map((code) => `add.errors.${code}`),
      ...["ok", "near", "exceeded"].map((level) => `overview.repository.${level}`),
      ...["overview", "restore-points", "runs", "settings"].map((tab) => `detail.tabs.${tab}`),
      ...["source", "target"].map((role) => `settings.copies.${role}`),
      ...["overwrite", "mirror"].map((mode) => `copy.modes.${mode}`),
      ...[
        "maxConcurrentRunners",
        "runnerMemoryMiB",
        "goMemLimitPercent",
        "maxRunHours",
        "defaultReadConcurrency",
        "defaultShareQuotaGib",
        "tenantShareQuotaGib",
      ].flatMap((field) => [`runners.fields.${field}`, `runners.hints.${field}`]),
      ...Object.values(FILE_SHARE_PROBLEMS).map((type) =>
        shareErrorKey(new ApiError(409, { type, title: "x", status: 409 }, "x")),
      ),
    ];
    for (const key of required) {
      expect(english.has(key), key).toBe(true);
    }
  });
});

describe("words and tones", () => {
  it("keeps green for proof: a passed restore check and a restore that completed", () => {
    expect(readinessView("green").tone).toBe("success");
    expect(readinessView("unverified").tone).toBe("muted");
    expect(standingView("ok").tone).toBe("neutral");
    expect(runStatusView({ status: "succeeded", kind: "backup" }).tone).toBe("neutral");
    expect(runStatusView({ status: "succeeded", kind: "restore", trigger: "manual" })).toEqual({
      key: "runs.status.restored",
      tone: "success",
    });
    // A copy is not a restore anyone asked for: it completed, it proves nothing.
    expect(runStatusView({ status: "succeeded", kind: "restore", trigger: "copy" }).tone).toBe(
      "neutral",
    );
  });

  it("measures progress by bytes, else by files, else not at all", () => {
    const base = { phase: "backup", currentPath: "", bytesUploaded: 0, at: "" };
    expect(
      progressRatio({ ...base, bytesDone: 1, totalBytes: 4, filesDone: 0, totalFiles: 0 }),
    ).toBe(0.25);
    expect(
      progressRatio({ ...base, bytesDone: 0, totalBytes: 0, filesDone: 3, totalFiles: 4 }),
    ).toBe(0.75);
    expect(
      progressRatio({ ...base, bytesDone: 0, totalBytes: 0, filesDone: 0, totalFiles: 0 }),
    ).toBeNull();
    expect(progressRatio(null)).toBeNull();
  });

  it("reads the permission level from the attribute the test could read", () => {
    expect(permissionLevel({ readable: true, xattr: "system.cifs_ntsd_full" })).toBe("full");
    expect(permissionLevel({ readable: true, xattr: "system.cifs_ntsd" })).toBe("owner");
    expect(permissionLevel({ readable: true, xattr: "system.cifs_acl" })).toBe("dacl");
    expect(permissionLevel({ readable: true, xattr: "system.nfs4_acl" })).toBe("nfs");
    expect(permissionLevel({ readable: false, xattr: "system.cifs_ntsd" })).toBe("none");
    expect(permissionLevel(null)).toBe("none");
  });

  it("groups unknown item codes as other", () => {
    expect(itemCodeKey("locked_file")).toBe("items.codes.locked_file");
    expect(itemCodeKey("something_new")).toBe("items.codes.other");
  });

  it("puts the budget in percent only when there is one", () => {
    expect(budgetPercent(5 * 1024 ** 3, 10)).toBe(50);
    expect(budgetPercent(5 * 1024 ** 3, null)).toBeNull();
    expect(budgetPercent(null, 10)).toBeNull();
  });
});

describe("the add dialog's checks", () => {
  const smb = {
    ...newConnectionDraft("smb"),
    server: "files.example.com",
    share: "Projects",
    account: "CORP\\backup",
    password: "pw",
  };

  it("accepts a complete SMB connection and builds the request", () => {
    expect(checkConnection(smb)).toEqual({});
    expect(connectionInputOf({ ...smb, subfolder: "\\Finance\\2026\\" })).toEqual({
      protocol: "smb",
      server: "files.example.com",
      share: "Projects",
      subfolder: "Finance/2026",
      account: "CORP\\backup",
      password: "pw",
      smbVersion: "3.1.1",
      seal: false,
    });
  });

  it("refuses what the API refuses", () => {
    expect(checkConnection({ ...smb, server: "smb://files" }).server).toBe("serverNoProtocol");
    expect(checkConnection({ ...smb, server: "\\\\files" }).server).toBe("serverNoProtocol");
    expect(checkConnection({ ...smb, server: "300.1.1.1" }).server).toBe("serverInvalid");
    expect(checkConnection({ ...smb, share: "a/b" }).share).toBe("shareInvalid");
    expect(checkConnection({ ...smb, subfolder: "a/../b" }).subfolder).toBe("subfolderInvalid");
    expect(checkConnection({ ...smb, account: "back,up" }).account).toBe("accountInvalid");
    expect(checkConnection({ ...smb, smbVersion: "2.1", seal: true }).seal).toBe("sealNeedsSmb3");
    expect(checkConnection({ ...smb, password: "" }).password).toBe("required");
    expect(
      checkConnection({ ...smb, password: "" }, { passwordRequired: false }).password,
    ).toBeUndefined();
    const nfs = { ...newConnectionDraft("nfs"), server: "nas", export: "volume1" };
    expect(checkConnection(nfs).export).toBe("exportInvalid");
    expect(checkConnection({ ...nfs, export: "/volume1/data" })).toEqual({});
  });

  it("refuses a password a piece of which Docker would take as a mount flag", () => {
    expect(passwordProblem("abc,ro,def")).toBe("passwordMountFlag");
    expect(passwordProblem("abc,rox")).toBeNull();
    expect(passwordProblem("a\u0007b")).toBe("passwordControl");
    expect(passwordProblem("x".repeat(257))).toBe("passwordTooLong");
  });

  it("writes the location the way the server's people write it and suggests a name", () => {
    expect(locationOfDraft({ ...smb, subfolder: "Finance" })).toBe(
      "\\\\files.example.com\\Projects\\Finance",
    );
    const nfs = { ...newConnectionDraft("nfs"), server: "nas", export: "/volume1/data" };
    expect(locationOfDraft(nfs)).toBe("nas:/volume1/data");
    expect(suggestedName(smb)).toBe("Projects");
    expect(suggestedName({ ...smb, subfolder: "Finance/2026" })).toBe("2026");
    expect(suggestedName(nfs)).toBe("data");
  });

  it("tells a private address by its look", () => {
    expect(looksPrivate("192.168.1.10")).toBe(true);
    expect(looksPrivate("10.0.0.5")).toBe(true);
    expect(looksPrivate("fileserver")).toBe(true);
    expect(looksPrivate("nas.local")).toBe(true);
    expect(looksPrivate("files.example.com")).toBe(false);
    expect(looksPrivate("93.184.216.34")).toBe(false);
  });
});

describe("the restore defaults (4.7)", () => {
  it("puts the permissions back where they came from and verifies on NFS", () => {
    expect(restoreDefaults("original", "smb")).toEqual({ restorePermissions: true, verify: false });
    expect(restoreDefaults("new_folder", "nfs")).toEqual({
      restorePermissions: true,
      verify: true,
    });
    expect(restoreDefaults("other_share", "smb")).toEqual({
      restorePermissions: false,
      verify: false,
    });
  });

  it("names the default folder after the local time", () => {
    expect(defaultRestoreFolder(new Date(2026, 9, 10, 8, 5, 3))).toBe(
      "Restow-Restore-20261010-080503",
    );
  });
});
