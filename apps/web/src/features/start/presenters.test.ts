import { describe, expect, it } from "vitest";

import type { SetupItem, SetupWidget } from "@/features/dashboard/api";

import { canSeeStart, justCompleted, notNeededOffer, startView } from "./presenters";

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
