/**
 * From the agent's error codes to failure explanations (packages/core/src/
 * failures): what happened, why and what to do, in the operator's language.
 * The agent reports `errors[].code` and a message per run; the server keeps
 * both and stores one {@link FailureRecord} on the run for the explanation
 * the web app shows. The texts live in packages/i18n (`failures:cause.endpoint.*`).
 */
import { redactSensitiveText } from "../failures/redact.js";
import type {
  FailureCause,
  FailureCode,
  FailureParams,
  FailureTechnical,
} from "../failures/types.js";
import { INTERRUPTED_RUN_CODE, resticExitCodeOf } from "./run-errors.js";

export interface RunErrorInput {
  path?: string | null;
  message: string;
  code?: string | null;
}

const BY_CODE: Readonly<Record<string, FailureCode>> = {
  no_paths: "endpoint.no_paths",
  pre_hook_failed: "endpoint.pre_hook_failed",
  post_hook_failed: "endpoint.post_hook_failed",
  // A hook is configured, but root on the machine has not allowed hooks from the server.
  hooks_not_allowed: "endpoint.hooks_not_allowed",
  timeout: "endpoint.timeout",
  target_not_empty: "endpoint.target_not_empty",
  invalid_task: "endpoint.invalid_task",
  hash_mismatch: "endpoint.hash_mismatch",
  missing: "endpoint.file_missing",
  not_regular: "endpoint.file_not_regular",
  read_error: "endpoint.read_error",
  agent_stopped: "endpoint.agent_stopped",
  [INTERRUPTED_RUN_CODE]: "endpoint.interrupted",
};

/** restic's words for "the server could not be reached or answered badly" (exit code 1). */
const NETWORK_TEXT =
  /dial tcp|no such host|connection (?:refused|reset)|i\/o timeout|timeout awaiting|tls:|x509:|unexpected http response \(5\d\d\)|network is unreachable|unexpected EOF/i;
const REFUSED_TEXT = /unexpected http response \(40[13]\)|403 forbidden/i;

const NEEDS_FIRST = [
  "pre_hook_failed",
  "hooks_not_allowed",
  "no_paths",
  "timeout",
  "target_not_empty",
  "post_hook_failed",
  "invalid_task",
];

function cause(
  code: FailureCode,
  error: RunErrorInput,
  transient: boolean,
  params: FailureParams = {},
): FailureCause {
  const technical: FailureTechnical = {};
  if (error.code) technical.agentCode = error.code.slice(0, 80);
  if (error.path) technical.path = redactSensitiveText(error.path).slice(0, 300);
  if (error.message) technical.message = redactSensitiveText(error.message).slice(0, 500);
  return { code, transient, params, technical };
}

/** The explanation of one error the agent reported. */
export function classifyRunError(error: RunErrorInput): FailureCause {
  const known = error.code ? BY_CODE[error.code] : undefined;
  if (known) {
    const params: FailureParams = error.path ? { path: error.path.slice(0, 300) } : {};
    return cause(
      known,
      error,
      known === "endpoint.timeout" || known === "endpoint.interrupted",
      params,
    );
  }
  const exitCode = resticExitCodeOf(error.code ?? undefined);
  if (exitCode !== null) {
    const params: FailureParams = { exitCode };
    if (exitCode === 10) return cause("endpoint.repository_missing", error, false, params);
    if (exitCode === 11) return cause("endpoint.repository_locked", error, true, params);
    if (exitCode === 12) return cause("endpoint.repository_password", error, false, params);
    if (exitCode === 3) return cause("endpoint.read_error", error, false, params);
    if (REFUSED_TEXT.test(error.message))
      return cause("endpoint.repository_refused", error, false, params);
    if (NETWORK_TEXT.test(error.message)) return cause("endpoint.network", error, true, params);
    return cause("endpoint.restic_failed", error, false, params);
  }
  if (REFUSED_TEXT.test(error.message)) return cause("endpoint.repository_refused", error, false);
  if (NETWORK_TEXT.test(error.message)) return cause("endpoint.network", error, true);
  return cause("endpoint.restic_failed", error, false);
}

/**
 * The one explanation a finished run carries: the error that decides what the
 * operator has to do first (a hook or a missing folder before anything else), or the
 * first one. `null` for a run without errors. `count` is how many errors were reported.
 */
export function failureOfRun(errors: readonly RunErrorInput[]): FailureCause | null {
  if (errors.length === 0) {
    return null;
  }
  const first =
    NEEDS_FIRST.map((code) => errors.find((error) => error.code === code)).find(Boolean) ??
    errors[0];
  if (!first) {
    return null;
  }
  const result = classifyRunError(first);
  if (errors.length > 1) {
    result.params = { ...result.params, count: errors.length };
  }
  return result;
}

/** The explanation of a run the server closed because its agent stopped reporting. */
export function agentStoppedCause(): FailureCause {
  return {
    code: "endpoint.agent_stopped",
    transient: true,
    params: {},
    technical: {},
  };
}

/** A repository check found damaged or missing data. */
export function repositoryDamagedCause(message?: string | null): FailureCause {
  return {
    code: "endpoint.repository_damaged",
    transient: false,
    params: {},
    technical: message ? { message: redactSensitiveText(message).slice(0, 500) } : {},
  };
}

/** A server that stopped reporting. */
export function silentCause(ageHours: number): FailureCause {
  return {
    code: "endpoint.silent",
    transient: false,
    params: { ageHours: Math.max(1, Math.round(ageHours)) },
    technical: {},
  };
}

/** A client without a good backup for days. */
export function backupOverdueCause(ageDays: number): FailureCause {
  return {
    code: "endpoint.backup_overdue",
    transient: false,
    params: { ageDays: Math.max(1, Math.round(ageDays)) },
    technical: {},
  };
}
