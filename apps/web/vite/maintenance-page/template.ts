/**
 * The markup and the styles of the static maintenance page. Pure string
 * building: the texts arrive translated, the product name arrives from the
 * branding (`buildProductName`), and nothing here names a product.
 *
 * The page is served under the edge's content security policy
 * (`script-src 'self'`), so it carries no inline script and no inline style:
 * the behaviour lives in maintenance.js and the looks in maintenance.css.
 * Every text the script shows sits in `data-*` attributes of `<main>`.
 */

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

/** Where the edge serves the page's own files. */
export const ASSET_BASE = "/maintenance";

/** The translated texts of one language, already picked out of the `updates` namespace. */
export interface PageTexts {
  lang: string;
  /** The product name of the branding. */
  product: string;
  /** `updates:maintenancePage.*`. */
  page: {
    heading: Record<
      | "unavailable"
      | "scheduled"
      | "scheduledVersion"
      | "updating"
      | "updatingVersion"
      | "succeeded"
      | "succeededVersion"
      | "failed",
      string
    >;
    lead: Record<"refresh" | "scheduled" | "succeeded", string>;
    failure: Record<"unchanged" | "rolledBack" | "needsAttention" | "generic", string>;
    reason: string;
    restarting: string;
    retry: string;
    progress: string;
    stepsLabel: string;
  };
  /** `updates:steps.<id>` and `updates:steps.status.<status>`. */
  steps: Record<(typeof STEP_IDS)[number], string>;
  stepStatus: Record<(typeof STEP_STATUSES)[number], string>;
  /** `updates:failure.*`, keyed by the failure code (`fetch.pull_failed`). */
  failures: Record<string, string>;
}

/**
 * The brand mark (brand guide, section 2) as inline SVG: no image request, and
 * no inline style either, the colours come from the stylesheet. Decorative:
 * the product name next to it is the text.
 */
export const MARK =
  '<svg class="mark" viewBox="0 0 48 48" width="28" height="28" aria-hidden="true" focusable="false"><path class="hold" d="M10 13 v15 a10 10 0 0 0 10 10 h8 a10 10 0 0 0 10-10 V13" fill="none" stroke-width="7" stroke-linecap="round"/><rect class="bar" x="15.5" y="25" width="17" height="7" rx="2"/></svg>';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `{product}` is filled at build time; `{version}` and `{reason}` are left for the script. */
function withProduct(template: string, product: string): string {
  return template.replace(/\{product\}/g, product);
}

function attribute(name: string, value: string): string {
  return `${name}="${escapeHtml(value)}"`;
}

/** The attribute holding a failure code's text (`fetch.pull_failed` becomes `data-failure-fetch-pull-failed`). */
export function failureAttributeName(code: string): string {
  return `data-failure-${code.replace(/[._]/g, "-")}`;
}

/** Every `data-*` attribute of `<main>`: the texts the script needs. */
export function textAttributes(texts: PageTexts): string[] {
  const { page, product } = texts;
  const fill = (template: string) => withProduct(template, product);
  const entries: [string, string][] = [
    ["heading-unavailable", fill(page.heading.unavailable)],
    ["heading-scheduled", fill(page.heading.scheduled)],
    ["heading-scheduled-version", fill(page.heading.scheduledVersion)],
    ["heading-updating", fill(page.heading.updating)],
    ["heading-updating-version", fill(page.heading.updatingVersion)],
    ["heading-succeeded", fill(page.heading.succeeded)],
    ["heading-succeeded-version", fill(page.heading.succeededVersion)],
    ["heading-failed", fill(page.heading.failed)],
    ["lead-refresh", fill(page.lead.refresh)],
    ["lead-scheduled", fill(page.lead.scheduled)],
    ["lead-succeeded", fill(page.lead.succeeded)],
    ["failure-unchanged", fill(page.failure.unchanged)],
    ["failure-rolled-back", fill(page.failure.rolledBack)],
    ["failure-needs-attention", fill(page.failure.needsAttention)],
    ["failure-generic", fill(page.failure.generic)],
    ["reason", page.reason],
  ];
  for (const id of STEP_IDS) {
    entries.push([`step-${id}`, texts.steps[id]]);
  }
  for (const status of STEP_STATUSES) {
    entries.push([`step-status-${status}`, texts.stepStatus[status]]);
  }
  const attributes = entries.map(([name, value]) => attribute(`data-text-${name}`, value));
  for (const code of Object.keys(texts.failures).sort()) {
    attributes.push(attribute(failureAttributeName(code), texts.failures[code] ?? ""));
  }
  return attributes;
}

/** One language of the page. */
export function renderPage(texts: PageTexts): string {
  const { page, product } = texts;
  const heading = withProduct(page.heading.unavailable, product);
  const steps = STEP_IDS.map(
    (id) =>
      `        <li data-step="${id}" data-status="pending"><span class="icon" aria-hidden="true"></span><span class="name">${escapeHtml(texts.steps[id])}</span><span class="state visually-hidden">${escapeHtml(texts.stepStatus.pending)}</span></li>`,
  ).join("\n");

  return `<!doctype html>
<html lang="${escapeHtml(texts.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(heading)}</title>
<link rel="stylesheet" href="${ASSET_BASE}/maintenance.css">
<noscript><meta http-equiv="refresh" content="15"></noscript>
<script src="${ASSET_BASE}/maintenance.js" defer></script>
</head>
<body>
<main id="maintenance" class="page"
  ${textAttributes(texts).join("\n  ")}>
  <section class="card">
    <div class="masthead">
      ${MARK}
      <p class="brand">${escapeHtml(product)}</p>
    </div>
    <h1 id="heading">${escapeHtml(heading)}</h1>
    <div id="live" role="status" aria-live="polite" aria-atomic="true">
      <p id="lead" class="lead">${escapeHtml(withProduct(page.lead.refresh, product))}</p>
      <p id="current" class="current" hidden></p>
    </div>
    <progress id="progress" class="progress" max="100" value="0" aria-label="${escapeHtml(page.progress)}" hidden></progress>
    <ol id="steps" class="steps" aria-label="${escapeHtml(page.stepsLabel)}" hidden>
${steps}
    </ol>
    <p id="restarting" class="note" hidden>${escapeHtml(page.restarting)}</p>
    <div id="failure" class="failure" hidden>
      <p id="failure-text"></p>
      <p id="failure-reason" class="reason" hidden></p>
    </div>
    <p class="actions"><a class="button" href="">${escapeHtml(page.retry)}</a></p>
  </section>
</main>
</body>
</html>
`;
}

/**
 * The stylesheet: light and dark by the visitor's setting, no images, no
 * fonts to download, motion only where it is welcome.
 */
export const STYLES = `:root {
  color-scheme: light dark;
  --bg: #f4f4f5;
  --card: #ffffff;
  --fg: #18181b;
  --muted: #52525b;
  --border: #d4d4d8;
  --track: #e4e4e7;
  --accent: #18181b;
  --ok: #15803d;
  --info: #1d4ed8;
  --err: #b91c1c;
  --warn: #b45309;
  --focus: #1d4ed8;
  --mark-hold: #0f1b2d;
  --mark-bar: #2b4c9b;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #09090b;
    --card: #18181b;
    --fg: #fafafa;
    --muted: #a1a1aa;
    --border: #3f3f46;
    --track: #3f3f46;
    --accent: #fafafa;
    --ok: #4ade80;
    --info: #60a5fa;
    --err: #f87171;
    --warn: #fbbf24;
    --focus: #93c5fd;
    --mark-hold: #f4f5f7;
    --mark-bar: #9db4e6;
  }
}

*, *::before, *::after { box-sizing: border-box; }

[hidden] { display: none !important; }

html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }

body {
  margin: 0;
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

.page { width: 100%; padding: 16px; }

.card {
  max-width: 32rem;
  margin: 0 auto;
  padding: 28px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.masthead {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 12px;
}

.mark { flex: none; width: 28px; height: 28px; }
.mark .hold { stroke: var(--mark-hold); }
.mark .bar { fill: var(--mark-bar); }

.brand {
  margin: 0;
  color: var(--muted);
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

h1 {
  margin: 0 0 8px;
  font-size: 1.5rem;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

p { margin: 0 0 12px; }

.lead { color: var(--muted); }

.current { font-weight: 600; }

.note { color: var(--muted); font-size: 0.9375rem; }

.progress {
  display: block;
  width: 100%;
  height: 8px;
  margin: 16px 0;
  border: 0;
  border-radius: 999px;
  overflow: hidden;
  background: var(--track);
  color: var(--accent);
  -webkit-appearance: none;
  appearance: none;
}
.progress::-webkit-progress-bar { background: var(--track); }
.progress::-webkit-progress-value { background: var(--accent); }
.progress::-moz-progress-bar { background: var(--accent); }

.steps {
  margin: 16px 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 10px;
}

.steps li {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 0.9375rem;
}

.steps li[data-status="pending"] .name { color: var(--muted); }
.steps li[data-status="running"] .name { font-weight: 600; }

.icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}

li[data-status="running"] .icon {
  border-color: var(--info);
  border-top-color: transparent;
  animation: spin 1s linear infinite;
}
li[data-status="done"] .icon { border-color: var(--ok); background: var(--ok); color: var(--card); }
li[data-status="done"] .icon::before { content: "\\2713"; }
li[data-status="failed"] .icon { border-color: var(--err); background: var(--err); color: var(--card); }
li[data-status="failed"] .icon::before { content: "\\2715"; }
li[data-status="skipped"] .icon { color: var(--muted); }
li[data-status="skipped"] .icon::before { content: "-"; }

@keyframes spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  li[data-status="running"] .icon { animation: none; border-top-color: var(--info); }
}

.failure {
  margin: 16px 0;
  padding: 12px 14px;
  border: 1px solid var(--err);
  border-radius: 10px;
}
.failure p:last-child { margin-bottom: 0; }
.reason { color: var(--muted); font-size: 0.9375rem; }

.actions { margin: 20px 0 0; }

.button {
  display: inline-block;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--fg);
  font-weight: 500;
  text-decoration: none;
}
.button:hover { background: var(--bg); }

a:focus-visible, .button:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 420px) {
  .card { padding: 20px; }
  h1 { font-size: 1.3125rem; }
}
`;
