import { describe, expect, it } from "vitest";

import type { SetupItem, SetupWidget } from "@/features/dashboard/api";

import {
  type DismissStorage,
  canSeeStart,
  justCompleted,
  notNeededOffer,
  readStartDismissed,
  startDismissedKey,
  startView,
  writeStartDismissed,
} from "./presenters";

const item = (over: Partial<SetupItem> = {}): SetupItem => ({
  id: "storage",
  state: "open",
  reason: null,
  actionable: true,
  ...over,
});

const setup = (over: Partial<SetupWidget> = {}): SetupWidget => ({
  complete: false,
  done: 3,
  total: 7,
  items: [],
  ...over,
});

describe("who sees Start", () => {
  it("is for the admins of the tenant, never an end user", () => {
    expect(canSeeStart("provider_admin")).toBe(true);
    expect(canSeeStart("tenant_admin")).toBe(true);
    expect(canSeeStart("tenant_user")).toBe(false);
    expect(canSeeStart(null)).toBe(false);
  });
});

describe("the entry", () => {
  it("shows how far the setup is, as a fraction for the ring", () => {
    expect(startView(setup({ done: 3, total: 7 }))).toEqual({
      done: 3,
      total: 7,
      fraction: 3 / 7,
    });
    expect(startView(setup({ done: 0 }))?.fraction).toBe(0);
  });

  it("is gone once every step is done, and while the checklist is not known", () => {
    expect(startView(setup({ complete: true, done: 7 }))).toBeNull();
    expect(startView(null)).toBeNull();
    expect(startView(undefined)).toBeNull();
    expect(startView(setup({ total: 0, done: 0 }))).toBeNull();
  });
});

describe("the toast when the last step is done", () => {
  it("comes when the checklist of the same tenant goes from open to complete", () => {
    expect(
      justCompleted({ tenantId: "t1", complete: false }, { tenantId: "t1", complete: true }),
    ).toBe(true);
  });

  it("does not come when the app opens on a finished checklist, or on one that stays open", () => {
    expect(justCompleted(null, { tenantId: "t1", complete: true })).toBe(false);
    expect(
      justCompleted({ tenantId: "t1", complete: true }, { tenantId: "t1", complete: true }),
    ).toBe(false);
    expect(
      justCompleted({ tenantId: "t1", complete: false }, { tenantId: "t1", complete: false }),
    ).toBe(false);
  });

  it("does not come when another tenant is finished, or there is none", () => {
    expect(
      justCompleted({ tenantId: "t1", complete: false }, { tenantId: "t2", complete: true }),
    ).toBe(false);
    expect(
      justCompleted({ tenantId: null, complete: false }, { tenantId: null, complete: true }),
    ).toBe(false);
  });
});

describe("Not needed", () => {
  it("is offered on the notification mail while it is open or failing", () => {
    expect(notNeededOffer(item({ id: "notificationMail", state: "open" }))).toBe("mark");
    expect(notNeededOffer(item({ id: "notificationMail", state: "attention" }))).toBe("mark");
  });

  it("can be taken back once marked, but not where the setup skipped the mail", () => {
    expect(
      notNeededOffer(item({ id: "notificationMail", state: "not_needed", reason: "mail_marked" })),
    ).toBe("undo");
    expect(
      notNeededOffer(item({ id: "notificationMail", state: "not_needed", reason: "mail_skipped" })),
    ).toBeNull();
  });

  it("is offered nowhere else, and not on a step that is done", () => {
    expect(notNeededOffer(item({ id: "storage", state: "open" }))).toBeNull();
    expect(notNeededOffer(item({ id: "source", state: "attention" }))).toBeNull();
    expect(notNeededOffer(item({ id: "notificationMail", state: "done" }))).toBeNull();
  });
});

describe("Start dismissal", () => {
  const memory = (): DismissStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    };
  };

  it("remembers the choice per user and forgets it again", () => {
    const storage = memory();
    expect(readStartDismissed("u1", storage)).toBe(false);
    writeStartDismissed("u1", true, storage);
    expect(readStartDismissed("u1", storage)).toBe(true);
    expect(readStartDismissed("u2", storage)).toBe(false);
    expect(storage.data.get(startDismissedKey("u1"))).toBe("1");
    writeStartDismissed("u1", false, storage);
    expect(readStartDismissed("u1", storage)).toBe(false);
  });

  it("treats missing or failing storage as not hidden, without throwing", () => {
    const failing: DismissStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStartDismissed("u1", null)).toBe(false);
    expect(readStartDismissed("u1", failing)).toBe(false);
    expect(() => writeStartDismissed("u1", true, failing)).not.toThrow();
  });
});
