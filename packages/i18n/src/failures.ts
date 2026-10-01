/**
 * Variables for the failure explanation texts (`failures` namespace).
 *
 * A failure carries only the parameters that apply (the missing permission, the
 * host that did not answer, the seconds Microsoft asked to wait). ICU message
 * format cannot test whether a variable exists, and a variable that is not
 * supplied makes the whole message fail. So every text uses variables from the
 * fixed list below, and this function supplies all of them: the value when the
 * failure has it, a neutral default otherwise, plus a `has_<name>` flag
 * (`yes` / `no`) the texts branch on.
 *
 * The API, the web app and the completeness test all build their variables here,
 * so a text that compiles in the test compiles in the app.
 */

/** Parameters the texts may use, with the value used when a failure has none. */
export const FAILURE_TEXT_PARAMS = {
  permission: "",
  grantedInstead: "",
  host: "",
  port: 0,
  path: "",
  reason: "other",
  role: "other",
  side: "other",
  graphCode: "",
  aadsts: "",
  imapCode: "",
  systemCode: "",
  httpStatus: 0,
  retryAfterSeconds: 0,
  count: 0,
  ageHours: 0,
  ageDays: 0,
  exitCode: 0,
} as const satisfies Record<string, string | number>;

export type FailureTextParam = keyof typeof FAILURE_TEXT_PARAMS;

export type FailureTextValue = string | number | boolean | null | undefined;

/** Every variable a failure text may reference, ready to pass to `t()`. */
export function failureVariables(
  params: Readonly<Record<string, FailureTextValue>> = {},
): Record<string, string | number> {
  const variables: Record<string, string | number> = {};
  for (const [name, fallback] of Object.entries(FAILURE_TEXT_PARAMS)) {
    const value = params[name];
    const present =
      (typeof value === "string" && value.length > 0) ||
      (typeof value === "number" && Number.isFinite(value));
    variables[name] = present ? (value as string | number) : fallback;
    variables[`has_${name}`] = present ? "yes" : "no";
  }
  // `count` drives plurals: the flag alone must not turn a missing count into "0 items".
  return variables;
}
