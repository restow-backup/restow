import { describe, expect, it } from "vitest";

import {
  hiddenModulesOf,
  isModuleShown,
  MODULE_IDS,
  readModules,
  withShownModules,
} from "@/lib/modules";

/**
 * The modules of the installation as the web interface reads them: which are on (from the
 * profile), and whether something that belongs to modules is shown.
 */

describe("readModules", () => {
  it("takes the profile's modules in the order of the list and drops what it does not know", () => {
    expect(readModules({ modules: ["pve", "tape", "microsoft365"] })).toEqual([
      "microsoft365",
      "pve",
    ]);
  });

  it("reads a server from before modules, or one that names none, as every module on", () => {
    expect(readModules({})).toEqual([...MODULE_IDS]);
    expect(readModules(undefined)).toEqual([...MODULE_IDS]);
    expect(readModules({ modules: "pve" })).toEqual([...MODULE_IDS]);
    expect(readModules({ modules: [] })).toEqual([...MODULE_IDS]);
  });
});

describe("isModuleShown", () => {
  it("shows what belongs to no module, whatever is on", () => {
    expect(isModuleShown(undefined, ["pve"])).toBe(true);
    expect(isModuleShown([], ["pve"])).toBe(true);
  });

  it("shows what belongs to several modules while one of them is on", () => {
    expect(isModuleShown(["endpoints", "pve"], ["pve"])).toBe(true);
    expect(isModuleShown(["endpoints", "pve"], ["microsoft365"])).toBe(false);
    expect(isModuleShown(["archive"], ["microsoft365", "imap"])).toBe(false);
  });

  it("hides nothing while the profile is not there", () => {
    expect(isModuleShown(["pve"], null)).toBe(true);
    expect(isModuleShown(["pve"], undefined)).toBe(true);
  });
});

describe("withShownModules and hiddenModulesOf", () => {
  const items = [
    { id: "overview" },
    { id: "guests", modules: ["pve"] as const },
    { id: "jobs", modules: ["endpoints", "pve"] as const },
  ];

  it("keeps the order and leaves out what none of its modules shows", () => {
    expect(withShownModules(items, ["endpoints"]).map((item) => item.id)).toEqual([
      "overview",
      "jobs",
    ]);
    expect(withShownModules(items, null)).toHaveLength(3);
  });

  it("names the modules of something that is hidden, and none of something that is shown", () => {
    expect(hiddenModulesOf(["pve"], ["endpoints"])).toEqual(["pve"]);
    expect(hiddenModulesOf(["endpoints", "pve"], ["microsoft365"])).toEqual(["endpoints", "pve"]);
    expect(hiddenModulesOf(["endpoints", "pve"], ["pve"])).toEqual([]);
    expect(hiddenModulesOf(undefined, ["pve"])).toEqual([]);
  });
});
