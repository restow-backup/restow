import { describe, expect, it } from "vitest";

import {
  type FolderSelection,
  type WizardContext,
  type WizardState,
  buildCreateInput,
  canOpen,
  coveringDirectory,
  initialWizardState,
  stepBlocker,
  toggleFolderEntry,
  validateName,
  wizardReducer,
} from "./wizard-state";

const context: WizardContext = {
  uploadEnabled: true,
  folderEnabled: true,
  uploadsReady: 0,
  uploadsBusy: 0,
};

const file = (path: string): FolderSelection => ({
  path,
  name: path.split("/").pop() ?? path,
  type: "file",
  size: 10,
  format: "eml",
});
const directory = (path: string): FolderSelection => ({
  path,
  name: path.split("/").pop() ?? path,
  type: "directory",
  size: null,
  format: null,
});

function run(state: WizardState, ...actions: Parameters<typeof wizardReducer>[1][]) {
  return actions.reduce(wizardReducer, state);
}

describe("name", () => {
  it("must be 1 to 120 characters after trimming", () => {
    expect(validateName("")).toBe("empty");
    expect(validateName("   ")).toBe("empty");
    expect(validateName(" Archive 2019 ")).toBeNull();
    expect(validateName("x".repeat(120))).toBeNull();
    expect(validateName("x".repeat(121))).toBe("tooLong");
    expect(validateName(` ${"x".repeat(120)} `)).toBeNull();
  });
});

describe("folder selection", () => {
  it("ticks and unticks an entry", () => {
    const once = toggleFolderEntry([], file("a.eml"));
    expect(once.map((entry) => entry.path)).toEqual(["a.eml"]);
    expect(toggleFolderEntry(once, file("a.eml"))).toEqual([]);
  });

  it("lets a whole directory replace what was ticked inside it", () => {
    const selection = [file("mail/a.eml"), file("mail/sub/b.eml"), file("other.eml")];
    const next = toggleFolderEntry(selection, directory("mail"));
    expect(next.map((entry) => entry.path)).toEqual(["other.eml", "mail"]);
  });

  it("does not tick an entry that a ticked directory already covers", () => {
    const selection = [directory("mail")];
    expect(toggleFolderEntry(selection, file("mail/a.eml"))).toEqual(selection);
    expect(coveringDirectory(selection, "mail/sub/b.eml")?.path).toBe("mail");
    expect(coveringDirectory(selection, "mailbox/a.eml")).toBeNull();
    expect(coveringDirectory(selection, "mail")).toBeNull();
  });
});

describe("steps", () => {
  it("needs a source, then files, then a valid target", () => {
    expect(stepBlocker(initialWizardState, "source", context)).toBe("origin");
    const upload = run(initialWizardState, { type: "setOrigin", origin: "upload" });
    expect(stepBlocker(upload, "source", context)).toBeNull();
    expect(stepBlocker(upload, "files", context)).toBe("noFiles");
    expect(stepBlocker(upload, "files", { ...context, uploadsReady: 1 })).toBeNull();
    expect(stepBlocker(upload, "target", context)).toBe("name");
    expect(stepBlocker({ ...upload, name: "Archive" }, "target", context)).toBeNull();
  });

  it("lets the person continue while uploads are still running, but not start", () => {
    const upload = run(initialWizardState, { type: "setOrigin", origin: "upload" });
    const running = { ...context, uploadsBusy: 2 };
    expect(stepBlocker(upload, "files", running)).toBeNull();
    expect(stepBlocker(upload, "review", running)).toBe("uploading");
    expect(
      stepBlocker(upload, "review", { ...running, uploadsBusy: 0, uploadsReady: 2 }),
    ).toBeNull();
  });

  it("does not offer a source the server switched off", () => {
    const upload = run(initialWizardState, { type: "setOrigin", origin: "upload" });
    expect(stepBlocker(upload, "source", { ...context, uploadEnabled: false })).toBe(
      "uploadDisabled",
    );
    const folder = run(initialWizardState, { type: "setOrigin", origin: "folder" });
    expect(stepBlocker(folder, "source", { ...context, folderEnabled: false })).toBe(
      "folderDisabled",
    );
  });

  it("needs an existing mailbox when adding to one", () => {
    const state = run(initialWizardState, { type: "setTargetMode", mode: "existing" });
    expect(stepBlocker(state, "target", context)).toBe("mailbox");
    expect(stepBlocker({ ...state, objectId: "o1" }, "target", context)).toBeNull();
  });

  it("walks forward only over complete steps and back at any time", () => {
    let state = run(initialWizardState, { type: "next", context });
    expect(state.step).toBe("source");

    state = run(state, { type: "setOrigin", origin: "folder" }, { type: "next", context });
    expect(state.step).toBe("files");
    state = run(state, { type: "next", context });
    expect(state.step).toBe("files");

    state = run(
      state,
      { type: "toggleFolderEntry", entry: file("a.eml") },
      { type: "next", context },
    );
    expect(state.step).toBe("target");
    state = run(state, { type: "setName", name: "Old mail" }, { type: "next", context });
    expect(state.step).toBe("review");
    state = run(state, { type: "next", context });
    expect(state.step).toBe("review");

    state = run(state, { type: "back" }, { type: "back" });
    expect(state.step).toBe("files");
  });

  it("jumps to an earlier step and to a later one only when everything before it is complete", () => {
    const ready = run(
      initialWizardState,
      { type: "setOrigin", origin: "folder" },
      { type: "toggleFolderEntry", entry: file("a.eml") },
      { type: "setName", name: "Old mail" },
    );
    expect(canOpen(ready, "review", context)).toBe(true);
    expect(run(ready, { type: "goTo", step: "review", context }).step).toBe("review");

    const incomplete = { ...ready, name: "" };
    expect(canOpen(incomplete, "review", context)).toBe(false);
    expect(run(incomplete, { type: "goTo", step: "review", context }).step).toBe("source");
    expect(
      run({ ...incomplete, step: "target" }, { type: "goTo", step: "source", context }).step,
    ).toBe("source");
  });
});

describe("the request", () => {
  it("names a new mailbox and lists only ready uploads", () => {
    const state: WizardState = {
      ...initialWizardState,
      origin: "upload",
      name: "  Archive 2019  ",
      archive: true,
      folderSelection: [file("ignored.eml")],
    };
    expect(buildCreateInput(state, ["u1", "u2"])).toEqual({
      name: "Archive 2019",
      files: [
        { origin: "upload", uploadId: "u1" },
        { origin: "upload", uploadId: "u2" },
      ],
      archive: true,
    });
  });

  it("adds folder entries to an existing mailbox by id and never sends a name with it", () => {
    const state: WizardState = {
      ...initialWizardState,
      origin: "folder",
      targetMode: "existing",
      objectId: "o1",
      name: "left over",
      folderSelection: [directory("mail"), file("a.eml")],
    };
    const input = buildCreateInput(state, ["u-not-used"]);
    expect(input).toEqual({
      objectId: "o1",
      files: [
        { origin: "folder", path: "mail" },
        { origin: "folder", path: "a.eml" },
      ],
      archive: false,
    });
    expect("name" in input).toBe(false);
  });
});
