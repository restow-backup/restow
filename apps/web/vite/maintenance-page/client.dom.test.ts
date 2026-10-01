// @vitest-environment happy-dom
import path from "node:path";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { type Environment, RELOAD_BACKOFF_MS, RELOAD_STORAGE_KEY } from "./client";
import { buildMaintenancePages } from "./index";

/**
 * The page and its script together: the generated markup is put in a
 * document, the compiled script is run against it with a stand-in browser,
 * and the poll is stepped by hand.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const files = await buildMaintenancePages(ROOT);

interface Client {
  bootstrap: (environment?: Environment) => void;
}

/** Load the compiled script without letting it start itself. */
function compiledClient(): Client {
  const source = (files["maintenance.js"] as string).replace(
    /MaintenanceClient\.bootstrap\(\);\s*$/,
    "",
  );
  return new Function(`${source}\nreturn MaintenanceClient;`)() as Client;
}

function loadPage(lang: "en" | "de") {
  const html = files[`index.${lang}.html`] as string;
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
  document.body.innerHTML = body.replace(/<script[^>]*><\/script>/g, "");
  document.title = "";
}

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

interface Reply {
  status?: unknown;
  statusCode?: number;
  html?: boolean;
  fail?: boolean;
  ready?: number;
  /** The JSON body of the /readyz answer (default `{}`). */
  readyBody?: unknown;
  readyFails?: boolean;
}

function harness(initial: Reply, options: { storage?: Storage | null; now?: number } = {}) {
  const state = { reply: initial, now: options.now ?? 1_000_000_000 };
  const reload = vi.fn();
  /** Pending timers by id; the request timeouts clear theirs, so what stays is the next poll. */
  const pending = new Map<number, () => void>();
  let nextId = 0;
  const timers = {
    get length() {
      return pending.size;
    },
  };
  const storage =
    options.storage === undefined ? (new MemoryStorage() as unknown as Storage) : options.storage;
  const requested: string[] = [];
  const env: Environment = {
    document,
    fetch: async (input) => {
      requested.push(input);
      const reply = state.reply;
      if (input === "/readyz") {
        if (reply.readyFails) {
          throw new TypeError("Failed to fetch");
        }
        return new Response(JSON.stringify(reply.readyBody ?? {}), { status: reply.ready ?? 503 });
      }
      if (reply.fail) {
        throw new TypeError("Failed to fetch");
      }
      if (reply.html) {
        return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
      }
      return new Response(JSON.stringify(reply.status ?? {}), {
        status: reply.statusCode ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
    now: () => state.now,
    reload,
    setTimeout: (callback) => {
      nextId += 1;
      pending.set(nextId, callback);
      return nextId;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
    storage,
  };
  const settle = async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  /** Run the next poll, as the browser's timer would. */
  const next = async () => {
    const [id, callback] = [...pending.entries()].pop() ?? [];
    if (id !== undefined) {
      pending.delete(id);
    }
    callback?.();
    await settle();
  };
  return { env, state, reload, settle, next, requested, timers, storage };
}

const q = (id: string) => document.getElementById(id) as HTMLElement;
const text = (id: string) => (q(id).textContent ?? "").replace(/\s+/g, " ").trim();
const stepStatus = (step: string) =>
  document.querySelector<HTMLElement>(`[data-step="${step}"]`)?.getAttribute("data-status");

const RUNNING = {
  phase: "running",
  runId: "r-1",
  outcome: null,
  targetVersion: "0.2.0",
  step: "backup",
  steps: [
    { id: "prepare", status: "done" },
    { id: "fetch", status: "done" },
    { id: "backup", status: "running" },
    { id: "stop", status: "pending" },
  ],
  progress: 42,
  failureCode: null,
};

let client: Client;

beforeAll(() => {
  client = compiledClient();
});

beforeEach(() => {
  loadPage("en");
});

describe("the static state", () => {
  it("says it is unavailable and shows nothing that needs the script", () => {
    expect(text("heading")).toBe("Restow is temporarily unavailable");
    expect(text("lead")).toBe("This page refreshes automatically.");
    for (const id of ["current", "progress", "steps", "restarting", "failure"]) {
      expect(q(id).hidden, id).toBe(true);
    }
  });
});

describe("while the update runs", () => {
  it("shows the target version, the steps, the progress and that a restart is expected", async () => {
    const page = harness({ status: RUNNING });
    client.bootstrap(page.env);
    await page.settle();

    expect(page.requested).toEqual(["/_maintenance/status", "/readyz"]);
    expect(text("heading")).toBe("Restow is being updated to version 0.2.0");
    expect(document.title).toBe("Restow is being updated to version 0.2.0");
    expect(text("lead")).toBe("This page refreshes automatically.");
    expect(q("steps").hidden).toBe(false);
    expect(q("progress").hidden).toBe(false);
    expect(q("progress").getAttribute("value")).toBe("42");
    expect(["prepare", "fetch", "backup", "stop", "start"].map(stepStatus)).toEqual([
      "done",
      "done",
      "running",
      "pending",
      "pending",
    ]);
    expect(document.querySelector('[data-step="backup"]')?.getAttribute("aria-current")).toBe(
      "step",
    );
    expect(document.querySelector('[data-step="fetch"]')?.getAttribute("aria-current")).toBeNull();
    expect(text("current")).toBe("Backing up the database");
    expect(q("current").hidden).toBe(false);
    // A screen reader hears each step's state.
    expect(document.querySelector('[data-step="backup"] .state')?.textContent).toBe("In progress");
    expect(document.querySelector('[data-step="fetch"] .state')?.textContent).toBe("Done");
    expect(q("restarting").hidden).toBe(false);
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("keeps polling and follows the steps", async () => {
    const page = harness({ status: RUNNING });
    client.bootstrap(page.env);
    await page.settle();
    expect(page.timers).toHaveLength(1);

    page.state.reply = {
      status: {
        ...RUNNING,
        step: "start",
        progress: 75,
        steps: [
          ...RUNNING.steps.slice(0, 3).map((step) => ({ ...step, status: "done" })),
          { id: "stop", status: "done" },
          { id: "start", status: "running" },
        ],
      },
    };
    await page.next();
    expect(stepStatus("backup")).toBe("done");
    expect(stepStatus("start")).toBe("running");
    expect(q("progress").getAttribute("value")).toBe("75");
    expect(text("current")).toBe("Starting the new version");
    expect(page.timers).toHaveLength(1);
  });

  it("shows nothing wrong when the edge is restarting too", async () => {
    const page = harness({ status: RUNNING });
    client.bootstrap(page.env);
    await page.settle();

    for (const reply of [
      { fail: true, readyFails: true },
      { html: true },
      { statusCode: 502, status: {} },
    ]) {
      page.state.reply = reply;
      await page.next();
      // The page falls back to what it said before it knew anything, without an error.
      expect(text("heading")).toBe("Restow is temporarily unavailable");
      expect(q("failure").hidden).toBe(true);
      expect(page.timers).toHaveLength(1);
      expect(page.reload).not.toHaveBeenCalled();
    }
    page.state.reply = { status: RUNNING };
    await page.next();
    expect(text("heading")).toContain("being updated to version 0.2.0");
  });
});

describe("announced", () => {
  it("names the version and waits", async () => {
    const page = harness({
      status: { ...RUNNING, phase: "scheduled", steps: [], step: null, progress: 0 },
      ready: 200,
    });
    client.bootstrap(page.env);
    await page.settle();
    expect(text("heading")).toBe("Restow will be updated to version 0.2.0");
    expect(text("lead")).toBe("The update starts soon. This page refreshes automatically.");
    expect(q("steps").hidden).toBe(true);
    // Even an answering application is not a reason to reload while an update is announced.
    expect(page.reload).not.toHaveBeenCalled();
  });
});

describe("when the update failed", () => {
  it.each([
    [
      "unchanged",
      "The update could not start. Nothing was changed; the previous version is still running.",
    ],
    ["rolled_back", "The update failed and was rolled back. The previous version runs again."],
    [
      "needs_attention",
      "The update failed after the database was migrated. An administrator has to restore it. The steps are in the update guide of the documentation.",
    ],
  ])("says what it means for the installation (%s)", async (outcome, expected) => {
    const page = harness({
      status: {
        ...RUNNING,
        phase: "failed",
        outcome,
        failureCode: "health.timeout",
        steps: [{ id: "health", status: "failed" }],
        step: "health",
      },
    });
    client.bootstrap(page.env);
    await page.settle();
    expect(text("heading")).toBe("The update of Restow did not complete");
    expect(q("failure").hidden).toBe(false);
    expect(text("failure-text")).toBe(expected);
    expect(text("failure-reason")).toBe("Reason: The new version did not become healthy in time.");
    expect(stepStatus("health")).toBe("failed");
    expect(q("progress").hidden).toBe(true);
    expect(text("lead")).toBe("");
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("hides the reason for a failure code it does not know", async () => {
    const page = harness({
      status: { ...RUNNING, phase: "failed", outcome: "unchanged", failureCode: "some.newer_code" },
    });
    client.bootstrap(page.env);
    await page.settle();
    expect(q("failure-reason").hidden).toBe(true);
    expect(text("failure-reason")).toBe("");
  });

  it("reloads once the application answers again after a failure that changed nothing", async () => {
    const page = harness({
      status: { ...RUNNING, phase: "failed", outcome: "unchanged" },
      ready: 200,
    });
    client.bootstrap(page.env);
    await page.settle();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });
});

describe("reloading", () => {
  it("reloads when the application answers and nothing is announced or running", async () => {
    const page = harness({ status: { phase: "idle" }, ready: 200 });
    client.bootstrap(page.env);
    await page.settle();
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(page.timers).toHaveLength(0);
    expect(page.storage?.getItem(RELOAD_STORAGE_KEY)).toBe(String(page.state.now));
  });

  it("reloads when the edge is silent but the application is back", async () => {
    const page = harness({ fail: true, ready: 200 });
    client.bootstrap(page.env);
    await page.settle();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload while the application does not answer", async () => {
    const page = harness({ status: { phase: "idle" }, ready: 503 });
    client.bootstrap(page.env);
    await page.settle();
    expect(page.reload).not.toHaveBeenCalled();
    expect(page.timers).toHaveLength(1);
  });

  it("reloads when the application is up but waits for the worker or the scheduler", async () => {
    const page = harness({
      status: { phase: "idle" },
      ready: 503,
      readyBody: {
        status: "not_ready",
        checks: { database: true, worker: "missing", scheduler: "ok" },
      },
    });
    client.bootstrap(page.env);
    await page.settle();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload on a 503 whose database check fails, or that names nothing", async () => {
    for (const readyBody of [
      { status: "not_ready", checks: { database: false, worker: "missing", scheduler: "missing" } },
      { status: "not_ready" },
      "not json",
    ]) {
      const page = harness({ status: { phase: "idle" }, ready: 503, readyBody });
      client.bootstrap(page.env);
      await page.settle();
      expect(page.reload).not.toHaveBeenCalled();
    }
  });

  it("reloads when the status says the update succeeded, and shows that first", async () => {
    const page = harness({
      status: { ...RUNNING, phase: "succeeded", outcome: "succeeded", progress: 100 },
      ready: 503,
    });
    client.bootstrap(page.env);
    await page.settle();
    expect(text("heading")).toBe("Restow was updated to version 0.2.0");
    expect(text("lead")).toBe("The new version is running. This page reloads now.");
    expect(q("progress").getAttribute("value")).toBe("100");
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload in a loop when the reloaded page finds the same state", async () => {
    const storage = new MemoryStorage() as unknown as Storage;
    const first = harness(
      { status: { ...RUNNING, phase: "succeeded", outcome: "succeeded" } },
      { storage },
    );
    client.bootstrap(first.env);
    await first.settle();
    expect(first.reload).toHaveBeenCalledTimes(1);

    // The page loads again (a new script run) within seconds, still on the same status.
    loadPage("en");
    const second = harness(
      { status: { ...RUNNING, phase: "succeeded", outcome: "succeeded" } },
      { storage, now: first.state.now + 4000 },
    );
    client.bootstrap(second.env);
    await second.settle();
    expect(second.reload).not.toHaveBeenCalled();
    expect(second.timers).toHaveLength(1);

    // Later, it may try again.
    second.state.now += RELOAD_BACKOFF_MS;
    await second.next();
    expect(second.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload on 'succeeded' alone when it cannot remember having reloaded", async () => {
    const page = harness(
      { status: { ...RUNNING, phase: "succeeded", outcome: "succeeded" }, ready: 503 },
      { storage: null },
    );
    client.bootstrap(page.env);
    await page.settle();
    expect(page.reload).not.toHaveBeenCalled();
    expect(page.timers).toHaveLength(1);
    page.state.reply = { status: { phase: "idle" }, ready: 200 };
    await page.next();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when storage refuses the note", async () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    } as unknown as Storage;
    const page = harness({ status: { phase: "idle" }, ready: 200 }, { storage });
    client.bootstrap(page.env);
    await page.settle();
    expect(page.reload).not.toHaveBeenCalled();
    expect(page.timers).toHaveLength(1);
  });
});

describe("the German page", () => {
  it("speaks German from its own attributes", async () => {
    loadPage("de");
    const page = harness({ status: RUNNING });
    client.bootstrap(page.env);
    await page.settle();
    expect(text("heading")).toBe("Restow wird auf Version 0.2.0 aktualisiert");
    expect(text("current")).toBe("Datenbank sichern");
    expect(document.querySelector('[data-step="fetch"] .state')?.textContent).toBe("Fertig");
    expect(text("restarting")).toBe("Der Server startet neu. Das ist normal.");
  });
});

describe("a page without the parts it needs", () => {
  it("does nothing", () => {
    document.body.innerHTML = "<p>nothing</p>";
    const page = harness({ status: RUNNING });
    client.bootstrap(page.env);
    expect(page.requested).toEqual([]);
  });
});
