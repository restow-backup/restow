/**
 * The script of the static maintenance page.
 *
 * The page is served by the edge while the application is not answering
 * (a restart, an update). It has no framework and needs no api: this script
 * asks the edge for the updater's public status every few seconds, shows the
 * steps and the progress it learns, and reloads the page as soon as the
 * application answers again. Every text it shows comes from `data-*`
 * attributes of the page itself (translated at build time), so it holds no
 * strings of its own.
 *
 * The decisions are plain functions with no DOM in them, so they are tested
 * on their own (client.test.ts). The plugin (index.ts) compiles this file to a
 * single ES2019 script for the browser.
 */

/** Where the edge serves the updater's public status, and the api's readiness. */
export const STATUS_URL = "/_maintenance/status";
export const READY_URL = "/readyz";

export const POLL_INTERVAL_MS = 3000;
export const REQUEST_TIMEOUT_MS = 4000;
/** No automatic reload within this time of the previous one (a loop guard). */
export const RELOAD_BACKOFF_MS = 15000;
export const RELOAD_STORAGE_KEY = "maintenance.reloadedAt";

export const PHASES = ["idle", "scheduled", "running", "succeeded", "failed"] as const;
export const STEP_IDS = [
  "prepare",
  "fetch",
  "backup",
  "stop",
  "start",
  "health",
  "finish",
] as const;
export const STEP_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export const OUTCOMES = ["succeeded", "unchanged", "rolled_back", "needs_attention"] as const;

export type Phase = (typeof PHASES)[number];
export type StepId = (typeof STEP_IDS)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type Outcome = (typeof OUTCOMES)[number];

/** What the page needs of the public status. */
export interface PageStatus {
  phase: Phase;
  outcome: Outcome | null;
  targetVersion: string | null;
  step: StepId | null;
  steps: { id: StepId; status: StepStatus }[];
  progress: number;
  failureCode: string | null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (values as readonly string[]).indexOf(value) !== -1
    ? (value as T)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Read the status defensively; anything that is not one (an error page) is `null`. */
export function parseStatus(payload: unknown): PageStatus | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const phase = oneOf(PHASES, raw.phase);
  if (phase === null) {
    return null;
  }
  const steps: PageStatus["steps"] = [];
  if (Array.isArray(raw.steps)) {
    for (const entry of raw.steps) {
      const step = entry as Record<string, unknown> | null;
      const id = step ? oneOf(STEP_IDS, step.id) : null;
      const status = step ? oneOf(STEP_STATUSES, step.status) : null;
      if (id !== null && status !== null) {
        steps.push({ id, status });
      }
    }
  }
  const progress =
    typeof raw.progress === "number" && Number.isFinite(raw.progress) ? raw.progress : 0;
  return {
    phase,
    outcome: oneOf(OUTCOMES, raw.outcome),
    targetVersion: text(raw.targetVersion),
    step: oneOf(STEP_IDS, raw.step),
    steps,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    failureCode: text(raw.failureCode),
  };
}

/** What the page says: nothing known, announced, running, finished well, or finished badly. */
export type Mode = "unavailable" | "scheduled" | "updating" | "succeeded" | "failed";

export function modeOf(status: PageStatus | null): Mode {
  switch (status ? status.phase : "idle") {
    case "scheduled":
      return "scheduled";
    case "running":
      return "updating";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    default:
      return "unavailable";
  }
}

export interface ReloadInput {
  status: PageStatus | null;
  /** `GET /readyz` answered 200, or 503 with its database check passing (see `readReady`). */
  ready: boolean;
  now: number;
  /** When the page last reloaded itself; `null` when never (or unknown). */
  lastReloadAt: number | null;
  /** The time of a reload can be remembered across the reload (session storage works). */
  guarded: boolean;
}

/**
 * Whether to reload now: the application answers and no update is announced
 * or running, or the status says the update succeeded. Never twice within
 * {@link RELOAD_BACKOFF_MS}, and never on "succeeded" alone when the reload
 * could not be remembered (a page that comes back to this page would loop).
 */
export function shouldReload(input: ReloadInput): boolean {
  if (input.lastReloadAt !== null && input.now - input.lastReloadAt < RELOAD_BACKOFF_MS) {
    return false;
  }
  const phase = input.status ? input.status.phase : null;
  if (phase === "scheduled" || phase === "running") {
    return false;
  }
  if (phase === "succeeded" && input.guarded) {
    return true;
  }
  return input.ready;
}

/** Fill `{name}` placeholders; unknown names stay as they are. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match: string, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? (values[name] as string) : match,
  );
}

/** The attribute that holds the text of a failure code (`fetch.pull_failed` becomes `data-failure-fetch-pull-failed`). */
export function failureAttribute(code: string): string {
  return `data-failure-${code.replace(/[._]/g, "-")}`;
}

/** The status of every step; steps the status does not list are pending. */
export function stepStatuses(status: PageStatus | null): Record<StepId, StepStatus> {
  const result = {} as Record<StepId, StepStatus>;
  for (const id of STEP_IDS) {
    result[id] = "pending";
  }
  if (status) {
    for (const step of status.steps) {
      result[step.id] = step.status;
    }
  }
  return result;
}

/** The step to name as the current one: the running step, else the last one the status names. */
export function currentStep(status: PageStatus | null): StepId | null {
  if (!status) {
    return null;
  }
  for (const step of status.steps) {
    if (step.status === "running") {
      return step.id;
    }
  }
  return status.step;
}

export interface FailureView {
  /** Key of the `data-text-*` attribute with the explanation. */
  textKey: string;
  /** The translated reason, when the failure code is known to the page. */
  reasonAttribute: string | null;
}

/** Which explanation a failed run gets. */
export function failureView(status: PageStatus): FailureView {
  const textKey =
    status.outcome === "unchanged"
      ? "failure-unchanged"
      : status.outcome === "rolled_back"
        ? "failure-rolled-back"
        : status.outcome === "needs_attention"
          ? "failure-needs-attention"
          : "failure-generic";
  return {
    textKey,
    reasonAttribute: status.failureCode ? failureAttribute(status.failureCode) : null,
  };
}

// --- The page --------------------------------------------------------------------------------------

/** What the page needs from the browser (replaced in tests). */
export interface Environment {
  document: Document;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  reload: () => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  storage: Storage | null;
}

function browserEnvironment(): Environment {
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
    // Probe: a blocked storage throws on first use.
    storage.getItem(RELOAD_STORAGE_KEY);
  } catch {
    storage = null;
  }
  return {
    document,
    fetch: (input, init) => window.fetch(input, init),
    now: () => Date.now(),
    reload: () => window.location.reload(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    storage,
  };
}

function readLastReload(storage: Storage | null): number | null {
  if (!storage) {
    return null;
  }
  try {
    const value = Number(storage.getItem(RELOAD_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeLastReload(storage: Storage | null, at: number): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(RELOAD_STORAGE_KEY, String(at));
    return true;
  } catch {
    return false;
  }
}

async function request(env: Environment, url: string): Promise<Response | null> {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? env.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    return await env.fetch(url, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: controller ? controller.signal : undefined,
    });
  } catch {
    return null;
  } finally {
    if (timer !== null) {
      env.clearTimeout(timer);
    }
  }
}

async function readStatus(env: Environment): Promise<PageStatus | null> {
  const response = await request(env, STATUS_URL);
  if (!response || !response.ok) {
    return null;
  }
  const type = response.headers.get("content-type") || "";
  if (type.indexOf("json") === -1) {
    return null;
  }
  try {
    return parseStatus(await response.json());
  } catch {
    return null;
  }
}

/**
 * Whether the application answers: `/readyz` says ready (200), or says not ready (503) while
 * its own database check passes. The latter is an api that is up but waits for the worker or
 * the scheduler to report in; it serves the interface, which is what this page waits for.
 */
async function readReady(env: Environment): Promise<boolean> {
  const response = await request(env, READY_URL);
  if (response === null) {
    return false;
  }
  if (response.status === 200) {
    return true;
  }
  if (response.status !== 503) {
    return false;
  }
  try {
    const body = (await response.json()) as { checks?: { database?: unknown } } | null;
    return body?.checks?.database === true;
  } catch {
    return false;
  }
}

/** Set the text only when it changed, so a live region does not repeat itself. */
function setText(element: Element | null, value: string): void {
  if (element && element.textContent !== value) {
    element.textContent = value;
  }
}

/** Show the status on the page. */
export function render(env: Environment, status: PageStatus | null, ready: boolean): void {
  const doc = env.document;
  const root = doc.getElementById("maintenance");
  if (!root) {
    return;
  }
  const label = (name: string): string => root.getAttribute(`data-text-${name}`) || "";
  const mode = modeOf(status);
  const version = status?.targetVersion ? status.targetVersion : "";
  const withVersion = (base: string): string =>
    fill(label(version ? `${base}-version` : base), { version });

  const heading =
    mode === "scheduled"
      ? withVersion("heading-scheduled")
      : mode === "updating"
        ? withVersion("heading-updating")
        : mode === "succeeded"
          ? withVersion("heading-succeeded")
          : mode === "failed"
            ? label("heading-failed")
            : label("heading-unavailable");
  setText(doc.getElementById("heading"), heading);
  if (doc.title !== heading) {
    doc.title = heading;
  }

  const lead =
    mode === "succeeded"
      ? label("lead-succeeded")
      : mode === "scheduled"
        ? label("lead-scheduled")
        : label("lead-refresh");
  setText(doc.getElementById("lead"), mode === "failed" ? "" : lead);

  // The steps and the progress belong to a run that started.
  const showRun = mode === "updating" || mode === "succeeded" || mode === "failed";
  const steps = doc.getElementById("steps");
  const progress = doc.getElementById("progress");
  if (steps) {
    steps.hidden = !showRun;
  }
  if (progress) {
    progress.hidden = !(mode === "updating" || mode === "succeeded");
    if (status) {
      progress.setAttribute("value", String(mode === "succeeded" ? 100 : status.progress));
    }
  }
  const states = stepStatuses(status);
  const running = currentStep(status);
  if (steps) {
    for (const item of Array.prototype.slice.call(steps.querySelectorAll("li[data-step]"))) {
      const element = item as HTMLElement;
      const id = element.getAttribute("data-step") as StepId;
      const state = states[id] || "pending";
      element.setAttribute("data-status", state);
      if (id === running && mode === "updating") {
        element.setAttribute("aria-current", "step");
      } else {
        element.removeAttribute("aria-current");
      }
      setText(element.querySelector(".state"), label(`step-status-${state}`));
    }
  }

  // The step that runs now is what a screen reader hears about; the steps themselves stay quiet.
  const current = doc.getElementById("current");
  if (current) {
    const stepLabel = running && mode === "updating" ? label(`step-${running}`) : "";
    current.hidden = stepLabel.length === 0;
    setText(current, stepLabel);
  }

  const restarting = doc.getElementById("restarting");
  if (restarting) {
    restarting.hidden = !(mode === "updating" && !ready);
  }

  const failure = doc.getElementById("failure");
  if (failure) {
    failure.hidden = mode !== "failed" || !status;
    if (mode === "failed" && status) {
      const view = failureView(status);
      setText(doc.getElementById("failure-text"), label(view.textKey));
      const reasonText = view.reasonAttribute ? root.getAttribute(view.reasonAttribute) : null;
      const reason = doc.getElementById("failure-reason");
      if (reason) {
        reason.hidden = !reasonText;
        setText(reason, reasonText ? fill(label("reason"), { reason: reasonText }) : "");
      }
    }
  }
}

/** Start polling. Called once by the page. */
export function bootstrap(environment?: Environment): void {
  const env = environment || browserEnvironment();
  if (!env.document.getElementById("maintenance")) {
    return;
  }

  async function cycle(): Promise<void> {
    try {
      const status = await readStatus(env);
      const ready = await readReady(env);
      render(env, status, ready);

      const now = env.now();
      const guarded = env.storage !== null;
      const due = shouldReload({
        status,
        ready,
        now,
        lastReloadAt: readLastReload(env.storage),
        guarded,
      });
      if (due && (!guarded || writeLastReload(env.storage, now))) {
        env.reload();
        return;
      }
    } catch {
      // Whatever went wrong, the next cycle tries again.
    }
    env.setTimeout(() => {
      void cycle();
    }, POLL_INTERVAL_MS);
  }

  void cycle();
}
